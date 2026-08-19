import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('WhatsAppChatRepository', () => {
  let businessId: string;
  let accountId: string;
  let contacts: WhatsAppContactRepository;
  let chats: WhatsAppChatRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
    contacts = new WhatsAppContactRepository(pool);
    chats = new WhatsAppChatRepository(pool);
  });

  it('links a chat to a contact by stable JID, not by display name', async () => {
    const contact = await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '12462451422@s.whatsapp.net',
      jidKind: 'individual',
      displayName: 'John',
    });

    const chat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '12462451422@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      contactId: contact.id,
    });

    expect(chat.contactId).toBe(contact.id);
    expect(chat.chatJid).toBe(contact.whatsappJid);

    // Display name changes on the contact; the chat<->contact link survives unchanged.
    await contacts.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '12462451422@s.whatsapp.net',
      jidKind: 'individual',
      displayName: 'John Smith',
    });
    const chatAgain = await chats.findByJid(businessId, accountId, '12462451422@s.whatsapp.net');
    expect(chatAgain?.contactId).toBe(contact.id);
  });

  it('supports explicit chat types instead of defaulting everything to individual', async () => {
    const groupChat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '120363012345678901@g.us',
      jidKind: 'group',
      chatType: 'group',
    });
    expect(groupChat.chatType).toBe('group');
    expect(groupChat.isGroup).toBe(true);

    const statusChat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: 'status@broadcast',
      jidKind: 'broadcast',
      chatType: 'status',
    });
    expect(statusChat.chatType).toBe('status');
  });
});
