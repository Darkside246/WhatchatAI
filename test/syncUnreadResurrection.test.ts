import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * A history sync must never bring a handled conversation back.
 *
 * Reported as "the notification bar on sync brings up old messages": every
 * WhatsApp history sync re-upserts the whole chat list, and the upsert wrote
 * WhatsApp's own unread count straight over AURA's. WhatsApp's count is the
 * phone's opinion and the phone has no idea the operator read the thread in
 * AURA, so conversations dealt with weeks earlier came back with their
 * counts restored - onto the alert pill and onto "what to do next".
 */
describe('history sync and the unread count', () => {
  let businessId: string;
  let accountId: string;
  let repo: WhatsAppChatRepository;

  const JID = '15550007777@s.whatsapp.net';

  async function sync(unreadCount: number) {
    return repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: JID,
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount,
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    repo = new WhatsAppChatRepository(pool);
  });

  it('seeds a brand-new chat from the wire count', async () => {
    const chat = await sync(4);
    expect(chat.unreadCount).toBe(4);
  });

  it('does not raise the count on a chat the operator has already read', async () => {
    const chat = await sync(4);
    await repo.resetUnreadCount(chat.id);

    // The same chat comes back in the next history sync still reading as
    // unread on the phone. It must stay read here.
    const resynced = await sync(4);
    expect(resynced.unreadCount).toBe(0);
  });

  it('does not raise the count above what AURA already has', async () => {
    await sync(1);
    const resynced = await sync(9);
    expect(resynced.unreadCount).toBe(1);
  });

  it('still lowers the count for a chat genuinely read on the phone', async () => {
    await sync(5);
    const resynced = await sync(0);
    expect(resynced.unreadCount).toBe(0);
  });

  it('leaves the count alone when the sync carries no count at all', async () => {
    const chat = await sync(3);
    const resynced = await repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: JID,
      jidKind: 'individual',
      chatType: 'individual',
      name: 'Renamed by the sync',
    });
    expect(resynced.id).toBe(chat.id);
    expect(resynced.unreadCount).toBe(3);
  });
});

/**
 * The alert pill's own query. It had no unread filter at all, unlike its
 * sibling listNeedingHumanTakeover - so every chat ever left in
 * HUMAN_TAKEOVER stayed on the pill for good, read or not.
 */
describe('listHumanTakeoverAlerts', () => {
  let businessId: string;
  let accountId: string;
  let repo: WhatsAppChatRepository;

  async function takeoverChat(jid: string, unreadCount: number): Promise<string> {
    const chat = await repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: jid,
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount,
    });
    await repo.setAiMode(chat.id, 'HUMAN_TAKEOVER', 'manual_toggle');
    return chat.id;
  }

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    repo = new WhatsAppChatRepository(pool);
  });

  it('lists a handoff that still has unread messages', async () => {
    const chatId = await takeoverChat('15550001111@s.whatsapp.net', 2);
    const alerts = await repo.listHumanTakeoverAlerts(businessId);
    expect(alerts.map((alert) => alert.chat_id)).toEqual([chatId]);
  });

  it('drops a handoff once the operator has read it', async () => {
    const chatId = await takeoverChat('15550002222@s.whatsapp.net', 2);
    await repo.resetUnreadCount(chatId);

    const alerts = await repo.listHumanTakeoverAlerts(businessId);
    expect(alerts).toEqual([]);
  });

  it('brings it back when the customer writes again', async () => {
    const chatId = await takeoverChat('15550003333@s.whatsapp.net', 1);
    await repo.resetUnreadCount(chatId);
    expect(await repo.listHumanTakeoverAlerts(businessId)).toEqual([]);

    // A real new inbound message, which is the only thing that should raise
    // the count again.
    await pool.query('UPDATE whatsapp_chats SET unread_count = 1 WHERE id = $1', [chatId]);
    const alerts = await repo.listHumanTakeoverAlerts(businessId);
    expect(alerts.map((alert) => alert.chat_id)).toEqual([chatId]);
  });

  it('does not resurrect a read handoff on the next history sync', async () => {
    const chatId = await takeoverChat('15550004444@s.whatsapp.net', 3);
    await repo.resetUnreadCount(chatId);

    await repo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      unreadCount: 3,
    });

    expect(await repo.listHumanTakeoverAlerts(businessId)).toEqual([]);
  });

  it('agrees with listNeedingHumanTakeover about what is outstanding', async () => {
    const waiting = await takeoverChat('15550005555@s.whatsapp.net', 2);
    const handled = await takeoverChat('15550006666@s.whatsapp.net', 2);
    await repo.resetUnreadCount(handled);

    const alerts = await repo.listHumanTakeoverAlerts(businessId);
    const todo = await repo.listNeedingHumanTakeover(businessId);
    expect(alerts.map((alert) => alert.chat_id)).toEqual([waiting]);
    expect(todo.map((entry) => entry.id)).toEqual([waiting]);
  });
});
