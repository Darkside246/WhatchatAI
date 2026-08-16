import { beforeEach, describe, expect, it } from 'vitest';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { workspaceService, isChatNotFoundError } from '../src/services/workspaceService.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { pool } from '../src/db/pool.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';

function ingestedMessage(overrides: Partial<IngestedWhatsAppMessage> = {}): IngestedWhatsAppMessage {
  return {
    messageId: `UNREAD-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    remoteJid: '15550003333@s.whatsapp.net',
    jidKind: 'individual',
    phoneNumber: '+15550003333',
    participant: null,
    fromMe: false,
    pushName: 'Alex',
    isLive: true,
    upsertType: 'notify',
    messageTimestamp: new Date().toISOString(),
    contentType: 'text',
    documentSubtype: null,
    mimetype: null,
    fileName: null,
    textPreview: 'hi',
    ingestedAt: new Date().toISOString(),
    mediaDescriptor: null,
    ...overrides,
  };
}

describe('unread message counters (real Postgres increment/reset, no fabricated "seen" state)', () => {
  let businessId: string;
  let accountId: string;
  const accountJid = '15550001111@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);
  });

  it('increments unread_count for a real, live, inbound message', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage(),
    });

    expect(result.chat.unreadCount).toBe(1);

    const chatRepository = new WhatsAppChatRepository(pool);
    const persisted = await chatRepository.findById(result.chat.id);
    expect(persisted?.unreadCount).toBe(1);
  });

  it('accumulates unread_count across multiple real inbound messages', async () => {
    let chatId: string | null = null;
    for (let i = 0; i < 3; i += 1) {
      const result = await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid,
        ingested: ingestedMessage({ messageId: `UNREAD-SEQ-${i}` }),
      });
      chatId = result.chat.id;
    }

    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.findById(chatId!);
    expect(chat?.unreadCount).toBe(3);
  });

  it('never increments unread_count for our own outbound messages', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'UNREAD-OUTBOUND', fromMe: true }),
    });

    expect(result.chat.unreadCount).toBe(0);
  });

  it('never increments unread_count for historical (non-live) backfill', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'UNREAD-HISTORICAL', isLive: false, upsertType: 'append' }),
    });

    expect(result.chat.unreadCount).toBe(0);
  });

  it('resets the real unread counter to zero once the user actually views the chat', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'UNREAD-TO-RESET' }),
    });
    expect(result.chat.unreadCount).toBe(1);

    const markedRead = await workspaceService.markChatRead(businessId, accountId, result.chat.id);
    expect(markedRead?.unreadCount).toBe(0);

    const chatRepository = new WhatsAppChatRepository(pool);
    const persisted = await chatRepository.findById(result.chat.id);
    expect(persisted?.unreadCount).toBe(0);
  });

  it('a new message after the chat was marked read starts counting from zero again', async () => {
    const first = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'UNREAD-BEFORE-RESET' }),
    });
    await workspaceService.markChatRead(businessId, accountId, first.chat.id);

    const second = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'UNREAD-AFTER-RESET' }),
    });

    expect(second.chat.unreadCount).toBe(1);
  });

  it('refuses to mark another business\'s chat as read (tenant isolation)', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'UNREAD-CROSS-TENANT' }),
    });

    const otherBusinessId = await createTestBusiness();
    const otherAccountId = await createTestAccount(otherBusinessId, '15559999999@s.whatsapp.net');

    await expect(workspaceService.markChatRead(otherBusinessId, otherAccountId, result.chat.id)).rejects.toSatisfy(
      (error: unknown) => isChatNotFoundError(error),
    );

    const chatRepository = new WhatsAppChatRepository(pool);
    const persisted = await chatRepository.findById(result.chat.id);
    expect(persisted?.unreadCount).toBe(1); // untouched by the rejected cross-tenant attempt
  });
});
