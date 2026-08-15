import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('workspaceService.listChats (real Postgres timestamptz -> string mapping)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('sorts real chats by lastMessageAt without throwing, newest first, nulls last', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const messageRepository = new WhatsAppMessageRepository(pool);

    const older = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550001111@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const newer = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    // A chat with no messages yet - lastMessageAt stays null.
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550003333@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });

    const olderMessage = await messageRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: older.id,
      whatsappMessageId: 'WS-MSG-OLDER',
      remoteJid: older.chatJid,
      senderJid: older.chatJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'older message',
      timestamp: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    await chatRepository.recordLastMessage(older.id, olderMessage.id, '2026-01-01T00:00:00.000Z');

    const newerMessage = await messageRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: newer.id,
      whatsappMessageId: 'WS-MSG-NEWER',
      remoteJid: newer.chatJid,
      senderJid: newer.chatJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'newer message',
      timestamp: new Date('2026-06-01T00:00:00.000Z').toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    await chatRepository.recordLastMessage(newer.id, newerMessage.id, '2026-06-01T00:00:00.000Z');

    const chats = await workspaceService.listChats(businessId, accountId);

    expect(chats).toHaveLength(3);
    expect(chats.map((chat) => chat.chatJid)).toEqual([newer.chatJid, older.chatJid, '15550003333@s.whatsapp.net']);

    // The actual regression: lastMessageAt must be a real string (pg's
    // default Date-object parsing broke a direct .localeCompare() call).
    expect(typeof chats[0]?.lastMessageAt).toBe('string');
    expect(chats[0]?.lastMessageAt).not.toBeNull();
    expect(new Date(chats[0]!.lastMessageAt!).toISOString()).toBe(chats[0]!.lastMessageAt);
    expect(chats[2]?.lastMessageAt).toBeNull();
  });
});
