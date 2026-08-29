import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ConversationEventRepository } from '../src/repositories/conversationEventRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

async function createTestChat(businessId: string, accountId: string, jid = '15550009999@s.whatsapp.net'): Promise<string> {
  const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
    businessId,
    whatsappAccountId: accountId,
    chatJid: jid,
    jidKind: 'individual',
    chatType: 'individual',
  });
  return chat.id;
}

describe('ConversationEventRepository', () => {
  let businessId: string;
  let chatId: string;
  let repo: ConversationEventRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);
    chatId = await createTestChat(businessId, accountId);
    repo = new ConversationEventRepository(pool);
  });

  it('assigns sequence 1 with a null previousHash to the first event in a conversation', async () => {
    const event = await repo.append({ businessId, chatId, eventType: 'conversation_created' });
    expect(event.sequence).toBe(1);
    expect(event.previousHash).toBeNull();
    expect(event.payloadHash).toBeTruthy();
  });

  it('chains each subsequent event to the previous one\'s hash, in strict sequence order', async () => {
    const first = await repo.append({ businessId, chatId, eventType: 'conversation_created' });
    const second = await repo.append({ businessId, chatId, eventType: 'message_received', payload: { messageId: 'msg-1' } });
    const third = await repo.append({ businessId, chatId, eventType: 'goal_updated', payload: { description: 'resolve the issue' } });

    expect(second.sequence).toBe(2);
    expect(second.previousHash).toBe(first.payloadHash);
    expect(third.sequence).toBe(3);
    expect(third.previousHash).toBe(second.payloadHash);
  });

  it('never stores raw message text in the payload - only structured references', async () => {
    const event = await repo.append({ businessId, chatId, eventType: 'message_received', payload: { messageId: 'msg-1', contentType: 'text' } });
    expect(event.payload).toEqual({ messageId: 'msg-1', contentType: 'text' });
    expect(JSON.stringify(event.payload)).not.toMatch(/the ac is broken|hello|complaint text/i);
  });

  it('verify() confirms an intact chain, including after a full round-trip through the database', async () => {
    await repo.append({ businessId, chatId, eventType: 'conversation_created' });
    await repo.append({ businessId, chatId, eventType: 'message_received', payload: { messageId: 'msg-1' } });
    await repo.append({ businessId, chatId, eventType: 'state_updated', payload: { field: 'currentGoal' } });

    expect(await repo.verify(businessId, chatId)).toBe(true);
  });

  it('verify() detects a tampered payload', async () => {
    const event = await repo.append({ businessId, chatId, eventType: 'message_received', payload: { messageId: 'msg-1' } });
    await pool.query(`UPDATE conversation_events SET payload = '{"messageId":"tampered"}'::jsonb WHERE id = $1`, [event.id]);
    expect(await repo.verify(businessId, chatId)).toBe(false);
  });

  it('verify() detects a broken previousHash link', async () => {
    await repo.append({ businessId, chatId, eventType: 'conversation_created' });
    const second = await repo.append({ businessId, chatId, eventType: 'message_received', payload: { messageId: 'msg-1' } });
    await pool.query(`UPDATE conversation_events SET previous_hash = 'not-the-real-hash' WHERE id = $1`, [second.id]);
    expect(await repo.verify(businessId, chatId)).toBe(false);
  });

  it('two conversations in the same business each get their own independent sequence starting at 1', async () => {
    const accountId = await createTestAccount(businessId, '15550002222@s.whatsapp.net');
    const otherChatId = await createTestChat(businessId, accountId, '15550008888@s.whatsapp.net');

    await repo.append({ businessId, chatId, eventType: 'conversation_created' });
    await repo.append({ businessId, chatId, eventType: 'message_received' });
    const firstOfOther = await repo.append({ businessId, chatId: otherChatId, eventType: 'conversation_created' });

    expect(firstOfOther.sequence).toBe(1);
    expect(firstOfOther.previousHash).toBeNull();
  });

  it('assigns strictly increasing, non-colliding sequence numbers under real concurrent appends', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => repo.append({ businessId, chatId, eventType: 'message_received', payload: { messageId: `msg-${i}` } })),
    );
    const sequences = results.map((r) => r.sequence).sort((a, b) => a - b);
    expect(sequences).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await repo.verify(businessId, chatId)).toBe(true);
  });

  it('tenant isolation - listByChat scoped to another business never sees this conversation\'s events', async () => {
    await repo.append({ businessId, chatId, eventType: 'conversation_created' });
    const otherBusinessId = await createTestBusiness('Other Business');
    const events = await repo.listByChat(otherBusinessId, chatId);
    expect(events).toEqual([]);
  });
});
