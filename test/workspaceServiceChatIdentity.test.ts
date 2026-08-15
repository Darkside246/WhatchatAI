import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppJidMappingRepository } from '../src/repositories/whatsappJidMappingRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('workspaceService chat-list filtering and @lid identity resolution', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('excludes status/broadcast/newsletter chats from the main chat list', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);

    const realChat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550001111@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: 'status@broadcast',
      jidKind: 'broadcast',
      chatType: 'broadcast',
    });
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '120363000000000000@newsletter',
      jidKind: 'newsletter',
      chatType: 'newsletter',
    });

    const chats = await workspaceService.listChats(businessId, accountId);

    expect(chats).toHaveLength(1);
    expect(chats[0]?.id).toBe(realChat.id);
  });

  it('resolves a @lid chat to its real phone number via whatsapp_jid_mappings when no contact info is available', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const jidMappingRepository = new WhatsAppJidMappingRepository(pool);

    const lidJid = '234471341175024@lid';
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: lidJid,
      jidKind: 'lid',
      chatType: 'individual',
    });
    await jidMappingRepository.upsert(
      businessId,
      accountId,
      lidJid,
      '12462325431@s.whatsapp.net',
      '+12462325431',
      'baileys_alt_jid',
      'high',
    );

    const chats = await workspaceService.listChats(businessId, accountId);
    expect(chats).toHaveLength(1);
    expect(chats[0]?.chatJid).toBe(lidJid);
    expect(chats[0]?.displayName).toBe('+12462325431');
    expect(chats[0]?.phoneNumber).toBe('+12462325431');

    const chat = await chatRepository.findByJid(businessId, accountId, lidJid);
    const detail = await workspaceService.getChatDetail(businessId, accountId, chat!.id);
    expect(detail.resolvedPhoneNumber).toBe('+12462325431');
  });

  it('leaves a @lid chat showing the raw JID when no mapping is known yet - never fabricates a number', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const lidJid = '999999999999999@lid';
    await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: lidJid,
      jidKind: 'lid',
      chatType: 'individual',
    });

    const chats = await workspaceService.listChats(businessId, accountId);
    expect(chats[0]?.displayName).toBe(lidJid);
    expect(chats[0]?.phoneNumber).toBeNull();
  });
});
