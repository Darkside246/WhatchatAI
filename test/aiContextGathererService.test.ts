import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { gatherAiHandoffContext } from '../src/services/aiContextGathererService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('gatherAiHandoffContext (real Promise.all over Postgres, including real KB full-text search)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('gathers CRM contact, conversation history, and a real (empty) knowledge-base search result concurrently', async () => {
    const contactRepo = new WhatsAppContactRepository(pool);
    const chatRepo = new WhatsAppChatRepository(pool);
    const messageRepo = new WhatsAppMessageRepository(pool);
    const crmRepo = new CrmContactRepository(pool);

    const contact = await contactRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550009999',
      pushName: 'Context Test Contact',
    });

    const crmContact = await crmRepo.upsertForWhatsAppContact({
      businessId,
      whatsappContactId: contact.id,
      source: 'whatsapp',
      stage: 'new',
      leadStatus: 'open',
    });

    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
      contactId: contact.id,
    });

    await messageRepo.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId: 'CTX-MSG-1',
      remoteJid: '15550009999@s.whatsapp.net',
      senderJid: '15550009999@s.whatsapp.net',
      direction: 'inbound',
      messageType: 'text',
      textContent: 'earlier message in the conversation',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });

    const context = await gatherAiHandoffContext({
      businessId,
      chatId: chat.id,
      contactId: contact.id,
      queryText: 'What is my order status?',
    });

    expect(context.crmContact?.id).toBe(crmContact.id);
    expect(context.conversationHistory).toHaveLength(1);
    expect(context.conversationHistory[0]?.textContent).toBe('earlier message in the conversation');

    // A real knowledge base search now runs (Phase 6) - with no documents
    // created for this business, an honest "search worked, nothing to find"
    // result is expected: available, zero results, never fabricated matches.
    expect(context.knowledgeBase.available).toBe(true);
    expect(context.knowledgeBase.results).toEqual([]);
  });

  it('returns a null CRM contact for a group chat with no contactId, without failing the other lookups', async () => {
    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '120363000000000000@g.us',
      jidKind: 'group',
      chatType: 'group',
    });

    const context = await gatherAiHandoffContext({
      businessId,
      chatId: chat.id,
      contactId: null,
      queryText: 'group question',
    });

    expect(context.crmContact).toBeNull();
    expect(context.conversationHistory).toEqual([]);
  });
});
