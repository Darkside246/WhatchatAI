import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { WhatsAppGroupRepository } from '../src/repositories/whatsappGroupRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Real-Postgres coverage for the Settings "Change number" flow's honest
 * sync-count display (directive §4/§86: real DB values, never a fabricated
 * progress percentage). Covers each repository's new countByBusiness()
 * directly, plus workspaceService.getWhatsAppAccountStats()'s aggregation.
 */
describe('WhatsApp account stats - countByBusiness (real Postgres, tenant isolation)', () => {
  it('counts only this business\'s own chats/contacts/groups/messages, never another business\'s', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness();
    const accountA = await createTestAccount(businessA, '15550001111@s.whatsapp.net');
    const businessB = await createTestBusiness();
    const accountB = await createTestAccount(businessB, '15550002222@s.whatsapp.net');

    const chatRepo = new WhatsAppChatRepository(pool);
    const contactRepo = new WhatsAppContactRepository(pool);
    const groupRepo = new WhatsAppGroupRepository(pool);
    const messageRepo = new WhatsAppMessageRepository(pool);

    // Two real contacts/chats for business A, one for business B.
    const contactA1 = await contactRepo.upsertFromWhatsApp({ businessId: businessA, whatsappAccountId: accountA, whatsappJid: '15551110001@s.whatsapp.net', jidKind: 'individual', pushName: 'A1' });
    await contactRepo.upsertFromWhatsApp({ businessId: businessA, whatsappAccountId: accountA, whatsappJid: '15551110002@s.whatsapp.net', jidKind: 'individual', pushName: 'A2' });
    await contactRepo.upsertFromWhatsApp({ businessId: businessB, whatsappAccountId: accountB, whatsappJid: '15551110003@s.whatsapp.net', jidKind: 'individual', pushName: 'B1' });

    const chatA1 = await chatRepo.upsertFromWhatsApp({ businessId: businessA, whatsappAccountId: accountA, chatJid: '15551110001@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', contactId: contactA1.id });
    await chatRepo.upsertFromWhatsApp({ businessId: businessA, whatsappAccountId: accountA, chatJid: '15551110002@s.whatsapp.net', jidKind: 'individual', chatType: 'individual' });
    await chatRepo.upsertFromWhatsApp({ businessId: businessB, whatsappAccountId: accountB, chatJid: '15551110003@s.whatsapp.net', jidKind: 'individual', chatType: 'individual' });

    await groupRepo.upsertFromWhatsApp({ businessId: businessA, whatsappAccountId: accountA, groupJid: '15551119001-group@g.us', subject: 'A Group 1' });
    await groupRepo.upsertFromWhatsApp({ businessId: businessB, whatsappAccountId: accountB, groupJid: '15551119002-group@g.us', subject: 'B Group 1' });

    await messageRepo.insert({
      businessId: businessA, whatsappAccountId: accountA, chatId: chatA1.id, whatsappMessageId: 'MSG-A-1',
      remoteJid: '15551110001@s.whatsapp.net', senderJid: '15551110001@s.whatsapp.net', direction: 'inbound',
      messageType: 'text', textContent: 'hi', timestamp: new Date().toISOString(), fromMe: false, isHistorical: false,
    });
    await messageRepo.insert({
      businessId: businessA, whatsappAccountId: accountA, chatId: chatA1.id, whatsappMessageId: 'MSG-A-2',
      remoteJid: '15551110001@s.whatsapp.net', senderJid: accountA, direction: 'outbound',
      messageType: 'text', textContent: 'hello back', timestamp: new Date().toISOString(), fromMe: true, isHistorical: false,
    });

    expect(await chatRepo.countByBusiness(businessA)).toBe(2);
    expect(await contactRepo.countByBusiness(businessA)).toBe(2);
    expect(await groupRepo.countByBusiness(businessA)).toBe(1);
    expect(await messageRepo.countByBusiness(businessA)).toBe(2);

    // Tenant isolation - business B's own single row of each type, never business A's.
    expect(await chatRepo.countByBusiness(businessB)).toBe(1);
    expect(await contactRepo.countByBusiness(businessB)).toBe(1);
    expect(await groupRepo.countByBusiness(businessB)).toBe(1);
    expect(await messageRepo.countByBusiness(businessB)).toBe(0);
  });

  it('returns zero for a real business with no WhatsApp data at all yet', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();

    const chatRepo = new WhatsAppChatRepository(pool);
    expect(await chatRepo.countByBusiness(businessId)).toBe(0);
  });
});

describe('WorkspaceService.getWhatsAppAccountStats (real Postgres)', () => {
  it('aggregates all four real counts for the business', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const accountId = await createTestAccount(businessId);

    const contactRepo = new WhatsAppContactRepository(pool);
    const contact = await contactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15551110001@s.whatsapp.net', jidKind: 'individual', pushName: 'Real Contact' });

    const chatRepo = new WhatsAppChatRepository(pool);
    const chat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: '15551110001@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', contactId: contact.id });

    const groupRepo = new WhatsAppGroupRepository(pool);
    await groupRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, groupJid: '15551119001-group@g.us', subject: 'Real Group' });

    const messageRepo = new WhatsAppMessageRepository(pool);
    await messageRepo.insert({
      businessId, whatsappAccountId: accountId, chatId: chat.id, whatsappMessageId: 'MSG-1',
      remoteJid: '15551110001@s.whatsapp.net', senderJid: '15551110001@s.whatsapp.net', direction: 'inbound',
      messageType: 'text', textContent: 'hi', timestamp: new Date().toISOString(), fromMe: false, isHistorical: false,
    });

    const stats = await workspaceService.getWhatsAppAccountStats(businessId);

    expect(stats).toEqual({ chats: 1, contacts: 1, groups: 1, messages: 1 });
  });
});
