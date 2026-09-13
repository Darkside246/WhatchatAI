import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Clearing a conversation has to clear it everywhere.
 *
 * Reported from a real chat: clear it, start typing, and the last thing the
 * customer said reappears under their name in the conversation list for a
 * second or two. The messages really were soft-deleted - what was not
 * touched was the chat's own pointer at the last one, which is what the
 * list follows to build the preview. So the conversation looked empty when
 * you opened it and not empty from the outside.
 */

const CUSTOMER_JID = '15550008888@s.whatsapp.net';

describe('clearing a conversation', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  let chats: WhatsAppChatRepository;
  let messages: WhatsAppMessageRepository;

  let sequence = 0;

  async function arrive(text: string) {
    sequence += 1;
    const message = await messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId,
      whatsappMessageId: `wamid-clear-${sequence}`,
      remoteJid: CUSTOMER_JID,
      senderJid: CUSTOMER_JID,
      direction: 'inbound',
      messageType: 'text',
      textContent: text,
      timestamp: new Date(Date.UTC(2026, 0, 1, 14, 0, sequence)).toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    await chats.recordLastMessage(chatId, message.id, message.timestamp, true);
    return message;
  }

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    chats = new WhatsAppChatRepository(pool);
    messages = new WhatsAppMessageRepository(pool);
    sequence = 0;

    const chat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: CUSTOMER_JID,
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  it('leaves nothing in the conversation itself', async () => {
    await arrive('what are you doing now ?');
    await workspaceService.clearChatMessages(businessId, accountId, chatId);

    expect(await messages.listByChat(chatId)).toHaveLength(0);
  });

  it('leaves nothing under their name in the conversation list either', async () => {
    // The actual reported bug. The messages were gone and this was not.
    await arrive('what are you doing now ?');
    await workspaceService.clearChatMessages(businessId, accountId, chatId);

    const [summary] = await workspaceService.listChats(businessId, accountId);
    expect(summary?.lastMessagePreview).toBeNull();
    expect(summary?.lastMessageType).toBeNull();
  });

  it('keeps the conversation where it was in the list', async () => {
    // Clearing is not archiving. Nulling last_message_at would have fixed
    // the preview by dropping the conversation to the bottom of the list,
    // which is neither what clearing means nor what WhatsApp itself does.
    await arrive('morning');
    await workspaceService.clearChatMessages(businessId, accountId, chatId);

    const [summary] = await workspaceService.listChats(businessId, accountId);
    expect(summary?.lastMessageAt).not.toBeNull();
  });

  it('takes the unread badge with it', async () => {
    // A badge pointing at messages nobody can open any more.
    await arrive('you there?');
    await arrive('hello?');
    await workspaceService.clearChatMessages(businessId, accountId, chatId);

    const [summary] = await workspaceService.listChats(businessId, accountId);
    expect(summary?.unreadCount).toBe(0);
  });

  it('does not hand a cleared message back to anything that asks for it by id', async () => {
    // The same gap that fed the preview would have let a cleared message be
    // forwarded on to somebody else.
    const message = await arrive('something private');
    await workspaceService.clearChatMessages(businessId, accountId, chatId);

    expect(await messages.findByIdForBusiness(message.id, businessId)).toBeNull();
  });

  it('does not touch a different conversation', async () => {
    const other = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550007777@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const kept = await messages.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: other.id,
      whatsappMessageId: 'wamid-other',
      remoteJid: '15550007777@s.whatsapp.net',
      senderJid: '15550007777@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'still here',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    await chats.recordLastMessage(other.id, kept.id, kept.timestamp, true);

    await arrive('clear me');
    await workspaceService.clearChatMessages(businessId, accountId, chatId);

    const summaries = await workspaceService.listChats(businessId, accountId);
    const untouched = summaries.find((summary) => summary.id === other.id);
    expect(untouched?.lastMessagePreview).toBe('still here');
    expect(untouched?.unreadCount).toBe(1);
  });
});
