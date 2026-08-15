import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('WhatsAppMessageRepository', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  let messages: WhatsAppMessageRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    const chats = new WhatsAppChatRepository(pool);
    const chat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
    messages = new WhatsAppMessageRepository(pool);
  });

  it('persists a real message', async () => {
    const message = await messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'WA-MSG-1',
      remoteJid: '15550002222@s.whatsapp.net',
      senderJid: '15550002222@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'Hello there',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });

    expect(message.wasInserted).toBe(true);
    expect(message.textContent).toBe('Hello there');
  });

  it('prevents duplicate messages at the database level', async () => {
    const input = {
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'WA-MSG-DUP',
      remoteJid: '15550002222@s.whatsapp.net',
      senderJid: '15550002222@s.whatsapp.net',
      direction: 'inbound' as const,
      messageType: 'text' as const,
      textContent: 'first',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    };

    const first = await messages.insert(input);
    const second = await messages.insert({ ...input, textContent: 'a duplicate delivery of the same message' });

    expect(first.wasInserted).toBe(true);
    expect(second.wasInserted).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.textContent).toBe('first'); // the original content, not overwritten by the duplicate delivery

    const { rows } = await pool.query('SELECT count(*)::int AS count FROM whatsapp_messages WHERE whatsapp_message_id = $1', [
      'WA-MSG-DUP',
    ]);
    expect(rows[0].count).toBe(1);
  });

  it('records the historical flag for synced (non-live) messages', async () => {
    const message = await messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'WA-MSG-HIST',
      remoteJid: '15550002222@s.whatsapp.net',
      senderJid: '15550002222@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: true,
    });

    expect(message.isHistorical).toBe(true);
  });

  it('records the live flag for real-time messages', async () => {
    const message = await messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'WA-MSG-LIVE',
      remoteJid: '15550002222@s.whatsapp.net',
      senderJid: '15550002222@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });

    expect(message.isHistorical).toBe(false);
  });

  it('tracks message status separately from Baileys send success', async () => {
    const message = await messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: 'WA-MSG-STATUS',
      remoteJid: '15550002222@s.whatsapp.net',
      senderJid: accountId,
      direction: 'outbound',
      messageType: 'text',
      timestamp: new Date().toISOString(),
      fromMe: true,
      isHistorical: false,
      status: 'sent',
    });
    expect(message.status).toBe('sent');

    await messages.updateStatus(message.id, 'delivered');
    const updated = await messages.findById(message.id);
    expect(updated?.status).toBe('delivered');
  });
});
