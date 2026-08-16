import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { workspaceService, isEntitlementDeniedError } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

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

describe('workspaceService.createAgent (real entitlement enforcement, not just a hidden UI button)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('denies creation for a business with no active subscription - never fabricates an agent', async () => {
    await expect(workspaceService.createAgent(businessId, { name: 'Reception Agent' })).rejects.toThrow();

    try {
      await workspaceService.createAgent(businessId, { name: 'Reception Agent' });
      expect.fail('expected createAgent to reject');
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) {
        expect(error.reason).toBe('NO_ACTIVE_SUBSCRIPTION');
      }
    }

    const agents = await workspaceService.listAgents(businessId);
    expect(agents).toEqual([]);
  });

  it('creates a real, immediately ACTIVE agent once the business is entitled', async () => {
    await createTestSubscription(businessId, 'starter');
    const agent = await workspaceService.createAgent(businessId, {
      name: 'Reception Agent',
      persona: 'Friendly and concise',
      systemInstruction: 'Help qualify inbound leads.',
    });

    expect(agent.status).toBe('ACTIVE');
    expect(agent.name).toBe('Reception Agent');

    const agents = await workspaceService.listAgents(businessId);
    expect(agents.map((a) => a.id)).toContain(agent.id);
  });

  it('stops creating agents once the starter plan limit (2) is reached', async () => {
    await createTestSubscription(businessId, 'starter');
    await workspaceService.createAgent(businessId, { name: 'Agent 1' });
    await workspaceService.createAgent(businessId, { name: 'Agent 2' });

    await expect(workspaceService.createAgent(businessId, { name: 'Agent 3' })).rejects.toThrow();
    try {
      await workspaceService.createAgent(businessId, { name: 'Agent 3' });
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) {
        expect(error.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
        expect(error.limit).toBe(2);
      }
    }
  });
});
