import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { workspaceService, isEntitlementDeniedError, isChatNotFoundError } from '../src/services/workspaceService.js';
import { register } from '../src/services/authService.js';
import { listNotifications } from '../src/services/notificationService.js';
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

describe('workspaceService.updateAgentStatus (the real, business-wide AI kill switch)', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    await createTestSubscription(businessId, 'starter');
  });

  it('pausing an agent removes it from findActiveForBusiness - the same check the auto-reply worker gates on', async () => {
    const agent = await workspaceService.createAgent(businessId, { name: 'Reception Agent' });
    const agentRepository = new AiAgentRepository(pool);
    expect(await agentRepository.findActiveForBusiness(businessId)).not.toBeNull();

    const paused = await workspaceService.updateAgentStatus(businessId, agent.id, 'PAUSED');
    expect(paused.status).toBe('PAUSED');
    expect(await agentRepository.findActiveForBusiness(businessId)).toBeNull();

    const reactivated = await workspaceService.updateAgentStatus(businessId, agent.id, 'ACTIVE');
    expect(reactivated.status).toBe('ACTIVE');
    expect((await agentRepository.findActiveForBusiness(businessId))?.id).toBe(agent.id);
  });

  it('throws not-found for an agent belonging to a different business - never lets one tenant toggle another tenant\'s agent', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await createTestSubscription(otherBusinessId, 'starter');
    const otherAgent = await workspaceService.createAgent(otherBusinessId, { name: 'Other Agent' });

    await expect(workspaceService.updateAgentStatus(businessId, otherAgent.id, 'PAUSED')).rejects.toThrow();
    try {
      await workspaceService.updateAgentStatus(businessId, otherAgent.id, 'PAUSED');
      expect.fail('expected updateAgentStatus to reject');
    } catch (error) {
      expect(isChatNotFoundError(error)).toBe(true);
    }

    const agentRepository = new AiAgentRepository(pool);
    const untouched = await agentRepository.findById(otherAgent.id);
    expect(untouched?.status).toBe('ACTIVE');
  });

  it('throws not-found for a nonexistent agent id', async () => {
    await expect(
      workspaceService.updateAgentStatus(businessId, '00000000-0000-0000-0000-000000000000', 'PAUSED'),
    ).rejects.toThrow();
  });
});

describe('workspaceService.sendReaction (a real reaction send, not a faked local one)', () => {
  let businessId: string;
  let accountId: string;
  let messageId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const chatRepository = new WhatsAppChatRepository(pool);
    const messageRepository = new WhatsAppMessageRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550004444@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const message = await messageRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId: 'WS-MSG-REACT',
      remoteJid: chat.chatJid,
      senderJid: chat.chatJid,
      direction: 'inbound',
      messageType: 'text',
      textContent: 'react to me',
      timestamp: new Date().toISOString(),
      fromMe: false,
      isHistorical: false,
    });
    messageId = message.id;
  });

  it('rejects with a real "not connected" error rather than silently succeeding - no live socket exists in tests', async () => {
    await expect(workspaceService.sendReaction(businessId, accountId, messageId, '👍')).rejects.toThrow(/not connected/i);
  });

  it('throws not-found for a message belonging to a different business', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    await expect(workspaceService.sendReaction(otherBusinessId, accountId, messageId, '👍')).rejects.toThrow();
    try {
      await workspaceService.sendReaction(otherBusinessId, accountId, messageId, '👍');
      expect.fail('expected sendReaction to reject');
    } catch (error) {
      expect(isChatNotFoundError(error)).toBe(true);
    }
  });

  it('throws not-found for a nonexistent message id', async () => {
    await expect(
      workspaceService.sendReaction(businessId, accountId, '00000000-0000-0000-0000-000000000000', '👍'),
    ).rejects.toThrow();
  });
});

describe('workspaceService.updateAccountProfilePicture (pushes to WhatsApp itself, never a local-only swap)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('rejects with a real "not connected" error rather than silently succeeding - no live socket exists in tests', async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await expect(
      workspaceService.updateAccountProfilePicture(businessId, accountId, fakeJpeg, 'image/jpeg'),
    ).rejects.toThrow(/not connected/i);
  });

  it('throws not-found for an account belonging to a different business', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await expect(
      workspaceService.updateAccountProfilePicture(otherBusinessId, accountId, fakeJpeg, 'image/jpeg'),
    ).rejects.toThrow();
    try {
      await workspaceService.updateAccountProfilePicture(otherBusinessId, accountId, fakeJpeg, 'image/jpeg');
      expect.fail('expected updateAccountProfilePicture to reject');
    } catch (error) {
      expect(isChatNotFoundError(error)).toBe(true);
    }
  });

  it('throws not-found for a nonexistent account id', async () => {
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
    await expect(
      workspaceService.updateAccountProfilePicture(businessId, '00000000-0000-0000-0000-000000000000', fakeJpeg, 'image/jpeg'),
    ).rejects.toThrow();
  });
});

describe('workspaceService real notification triggers (HUMAN_HANDOFF and NEW_LEAD)', () => {
  let businessId: string;
  let accountId: string;
  let ownerId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    ownerId = owner.user.id;
    accountId = await createTestAccount(businessId);
  });

  it('setAiMode(...,"HUMAN_TAKEOVER") dispatches a real HUMAN_HANDOFF notification, but only on the real transition', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550009999@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });

    await workspaceService.setAiMode(businessId, accountId, chat.id, 'HUMAN_TAKEOVER');
    const { notifications } = await listNotifications(businessId, ownerId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('HUMAN_HANDOFF');
    expect(notifications[0]?.targetId).toBe(chat.id);

    // Setting it again (already HUMAN_TAKEOVER) must not create a duplicate.
    await workspaceService.setAiMode(businessId, accountId, chat.id, 'HUMAN_TAKEOVER');
    const after = await listNotifications(businessId, ownerId);
    expect(after.notifications).toHaveLength(1);
  });

  it('createLead dispatches a real NEW_LEAD notification', async () => {
    const contactRepository = new WhatsAppContactRepository(pool);
    const contact = await contactRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      whatsappJid: '15550008888@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550008888',
      pushName: 'Prospect',
    });
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO crm_contacts (business_id, whatsapp_contact_id, source, stage) VALUES ($1, $2, 'whatsapp_inbound', 'new_enquiry') RETURNING id`,
      [businessId, contact.id],
    );
    const crmContactId = rows[0]!.id;

    const lead = await workspaceService.createLead(businessId, { crmContactId, source: 'whatsapp_inbound' });
    const { notifications } = await listNotifications(businessId, ownerId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('NEW_LEAD');
    expect(notifications[0]?.targetId).toBe(lead.id);
  });
});
