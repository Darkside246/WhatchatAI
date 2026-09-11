import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { HumanHandoffLogRepository, EXCERPT_MAX_CHARS } from '../src/repositories/humanHandoffLogRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('human handoff log', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  const repository = new HumanHandoffLogRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '12465551234@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  it('records a real handoff and reads it back intact', async () => {
    await repository.record({
      businessId,
      chatId,
      reason: 'blocked_keyword',
      reasonDetail: 'refund',
      customerLabel: 'John Smith',
      customerPhone: '+12465551234',
      messageExcerpt: 'I want a refund right now',
    });

    const entries = await repository.list(businessId);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      chatId,
      reason: 'blocked_keyword',
      reasonDetail: 'refund',
      customerLabel: 'John Smith',
      customerPhone: '+12465551234',
      messageExcerpt: 'I want a refund right now',
    });
  });

  it('stores customer identity and message content ENCRYPTED at rest - a raw table read reveals neither', async () => {
    await repository.record({
      businessId,
      chatId,
      reason: 'no_agent',
      customerLabel: 'Kathy-Ann Caddle',
      customerPhone: '+12465559999',
      messageExcerpt: 'Can I get three chickens tomorrow?',
      reasonDetail: 'a secret detail',
    });

    // Raw SQL, bypassing the repository's own decryption - this is what an
    // attacker with a database dump and no MASTER_ENCRYPTION_KEY would see.
    const { rows } = await pool.query<{
      customer_label: string;
      customer_phone: string;
      message_excerpt: string;
      reason_detail: string;
      reason: string;
    }>('SELECT customer_label, customer_phone, message_excerpt, reason_detail, reason FROM human_handoff_log WHERE business_id = $1', [
      businessId,
    ]);

    const row = rows[0]!;
    expect(row.customer_label).not.toContain('Kathy-Ann');
    expect(row.customer_phone).not.toContain('12465559999');
    expect(row.message_excerpt).not.toContain('chickens');
    expect(row.reason_detail).not.toContain('secret');
    // The reason token itself carries no personal data and stays readable -
    // it is what the log is filtered and sorted by.
    expect(row.reason).toBe('no_agent');
  });

  it('bounds the stored excerpt instead of keeping a second full copy of the message', async () => {
    const long = 'x'.repeat(EXCERPT_MAX_CHARS * 3);
    await repository.record({ businessId, chatId, reason: 'ai_unavailable', messageExcerpt: long });

    const entries = await repository.list(businessId);
    expect(entries[0]!.messageExcerpt!.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
    expect(entries[0]!.messageExcerpt!.endsWith('…')).toBe(true);
  });

  it('never leaks another tenant\'s entries', async () => {
    const otherBusinessId = await createTestBusiness();
    const otherAccountId = await createTestAccount(otherBusinessId, '15559998888@s.whatsapp.net');
    const otherChat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId: otherBusinessId,
      whatsappAccountId: otherAccountId,
      chatJid: '15557776666@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });

    await repository.record({ businessId, chatId, reason: 'no_agent', customerLabel: 'Ours' });
    await repository.record({
      businessId: otherBusinessId,
      chatId: otherChat.id,
      reason: 'no_agent',
      customerLabel: 'Theirs',
    });

    const ours = await repository.list(businessId);
    expect(ours).toHaveLength(1);
    expect(ours[0]!.customerLabel).toBe('Ours');
    expect(await repository.count(businessId)).toBe(1);
  });

  it('lists newest first', async () => {
    await repository.record({ businessId, chatId, reason: 'no_agent', customerLabel: 'first' });
    await repository.record({ businessId, chatId, reason: 'ai_unavailable', customerLabel: 'second' });

    const entries = await repository.list(businessId);
    expect(entries.map((entry) => entry.customerLabel)).toEqual(['second', 'first']);
  });

  it('clears the log, and only for the business that asked', async () => {
    const otherBusinessId = await createTestBusiness();
    const otherAccountId = await createTestAccount(otherBusinessId, '15559997777@s.whatsapp.net');
    const otherChat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId: otherBusinessId,
      whatsappAccountId: otherAccountId,
      chatJid: '15557775555@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    await repository.record({ businessId: otherBusinessId, chatId: otherChat.id, reason: 'no_agent' });

    await repository.record({ businessId, chatId, reason: 'no_agent' });
    await repository.record({ businessId, chatId, reason: 'blocked_keyword' });

    expect(await repository.clear(businessId)).toBe(2);
    expect(await repository.count(businessId)).toBe(0);
    // The other tenant's row is untouched.
    expect(await repository.count(otherBusinessId)).toBe(1);
  });

  it('deletes a single entry, and reports honestly when it does not exist', async () => {
    const entry = await repository.record({ businessId, chatId, reason: 'no_agent' });

    expect(await repository.deleteEntry(businessId, entry.id)).toBe(true);
    expect(await repository.deleteEntry(businessId, entry.id)).toBe(false);
    expect(await repository.count(businessId)).toBe(0);
  });

  it('a delete from another tenant cannot remove our entry', async () => {
    const otherBusinessId = await createTestBusiness();
    const entry = await repository.record({ businessId, chatId, reason: 'no_agent' });

    expect(await repository.deleteEntry(otherBusinessId, entry.id)).toBe(false);
    expect(await repository.count(businessId)).toBe(1);
  });
});

describe('"What to do next" clears once a conversation is handled', () => {
  let businessId: string;
  let accountId: string;
  const chatRepository = new WhatsAppChatRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  async function takenOverChat(chatJid: string, unreadCount: number) {
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid,
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount,
    });
    await chatRepository.setAiMode(chat.id, 'HUMAN_TAKEOVER', 'no_agent');
    return chat;
  }

  it('lists a taken-over conversation that still has unread customer messages', async () => {
    const chat = await takenOverChat('12465551111@s.whatsapp.net', 2);
    const waiting = await chatRepository.listNeedingHumanTakeover(businessId);
    expect(waiting.map((entry) => entry.id)).toEqual([chat.id]);
  });

  it('drops it once the operator has opened it - opening resets the unread counter', async () => {
    const chat = await takenOverChat('12465552222@s.whatsapp.net', 3);
    expect(await chatRepository.listNeedingHumanTakeover(businessId)).toHaveLength(1);

    await chatRepository.resetUnreadCount(chat.id);

    expect(await chatRepository.listNeedingHumanTakeover(businessId)).toHaveLength(0);
  });

  it('brings it back when the customer writes again - it really does need attention again', async () => {
    const chat = await takenOverChat('12465553333@s.whatsapp.net', 1);
    await chatRepository.resetUnreadCount(chat.id);
    expect(await chatRepository.listNeedingHumanTakeover(businessId)).toHaveLength(0);

    await pool.query('UPDATE whatsapp_chats SET unread_count = 1 WHERE id = $1', [chat.id]);

    expect(await chatRepository.listNeedingHumanTakeover(businessId)).toHaveLength(1);
  });

  it('never lists a conversation the AI is still handling', async () => {
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '12465554444@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount: 5,
    });

    expect(await chatRepository.listNeedingHumanTakeover(businessId)).toHaveLength(0);
  });
});
