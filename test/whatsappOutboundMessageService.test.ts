import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { ConversationEventRepository } from '../src/repositories/conversationEventRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const enqueueOutboundMessageMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../src/queue/queues/outboundMessagesQueue.js', () => ({
  enqueueOutboundMessage: (...args: unknown[]) => enqueueOutboundMessageMock(...args),
}));

const { whatsappOutboundMessageService } = await import('../src/services/whatsappOutboundMessageService.js');

describe('WhatsAppOutboundMessageService.send() conversation event emission', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  const toJid = '15550007777@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: toJid,
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
    enqueueOutboundMessageMock.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('appends exactly one message_sent event for a new send', async () => {
    const record = await whatsappOutboundMessageService.send({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      messageType: 'text',
      text: 'Thanks for reaching out!',
      requestedBy: 'ai',
    });

    const events = await new ConversationEventRepository(pool).listByChat(businessId, chatId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'message_sent',
      payload: { outboundMessageId: record.id, messageType: 'text' },
    });
    // Never the raw text content, only a reference.
    expect(JSON.stringify(events[0]!.payload)).not.toContain('Thanks for reaching out');
  });

  it('does not append a second event for an idempotent retry with the same key', async () => {
    const idempotencyKey = 'ai-reply:retry-test';
    await whatsappOutboundMessageService.send({ businessId, whatsappAccountId: accountId, chatId, idempotencyKey, messageType: 'text', text: 'First attempt' });
    await whatsappOutboundMessageService.send({ businessId, whatsappAccountId: accountId, chatId, idempotencyKey, messageType: 'text', text: 'First attempt' });

    const events = await new ConversationEventRepository(pool).listByChat(businessId, chatId);
    expect(events).toHaveLength(1);
  });

  it('does not append an event when the chat is not found (send throws before any row is created)', async () => {
    await expect(
      whatsappOutboundMessageService.send({
        businessId,
        whatsappAccountId: accountId,
        chatId: '00000000-0000-0000-0000-000000000099',
        messageType: 'text',
        text: 'hello',
      }),
    ).rejects.toThrow('Chat not found');

    const events = await new ConversationEventRepository(pool).listByChat(businessId, chatId);
    expect(events).toEqual([]);
  });
});
