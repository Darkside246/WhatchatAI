import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import {
  workspaceService,
  isEntitlementDeniedError,
  isChatNotFoundError,
  isCapacityExceededError,
  isInvalidAssignmentError,
} from '../src/services/workspaceService.js';
import { register } from '../src/services/authService.js';
import { createMember } from '../src/services/workspaceMemberService.js';
import { createTeam, updateMyCapacity } from '../src/services/teamService.js';
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

describe('workspaceService.createAgentFromTemplate ("Build My Agent")', () => {
  let businessId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('creates a real agent pre-filled from the template, with the recommended tools as a real, enforced allow-list', async () => {
    await createTestSubscription(businessId, 'starter');
    const templates = await workspaceService.listAgentTemplates();
    const property = templates.find((t) => t.templateKey === 'property_operations_assistant')!;

    const agent = await workspaceService.createAgentFromTemplate(businessId, 'property_operations_assistant');

    expect(agent.name).toBe(property.name);
    expect(agent.systemInstruction).toBe(property.defaultSystemInstruction);
    expect(agent.category).toBe(property.category);
    expect(agent.allowedToolsEnabled).toBe(true);
    expect(agent.allowedTools).toEqual(property.recommendedTools);
    expect(agent.status).toBe('ACTIVE');
    // Real provenance (migration 956) - lets the UI honestly say "this
    // template has since been updated" without ever silently changing
    // an existing agent's own configuration.
    expect(agent.sourceTemplateKey).toBe('property_operations_assistant');
    expect(agent.sourceTemplateVersion).toBe(property.version);
  });

  it('a manually created agent has no source template - provenance is null, never a fabricated template link', async () => {
    await createTestSubscription(businessId, 'starter');
    const agent = await workspaceService.createAgent(businessId, { name: 'From scratch' });
    expect(agent.sourceTemplateKey).toBeNull();
    expect(agent.sourceTemplateVersion).toBeNull();
  });

  it('updateAgent preserves an agent\'s own source template provenance when the caller passes it back unchanged, and lets it be reset to a newer version explicitly', async () => {
    await createTestSubscription(businessId, 'starter');
    const agent = await workspaceService.createAgentFromTemplate(businessId, 'property_operations_assistant');
    expect(agent.sourceTemplateVersion).toBe(1);

    // An ordinary edit (e.g. changing the name) must not silently wipe or
    // alter provenance - the frontend round-trips it unchanged.
    const edited = await workspaceService.updateAgent(businessId, agent.id, {
      name: 'Renamed',
      sourceTemplateKey: agent.sourceTemplateKey,
      sourceTemplateVersion: agent.sourceTemplateVersion,
    });
    expect(edited.name).toBe('Renamed');
    expect(edited.sourceTemplateKey).toBe('property_operations_assistant');
    expect(edited.sourceTemplateVersion).toBe(1);

    // A real template content update (mirrors migration 953's own pattern) bumps the version.
    await pool.query(`UPDATE agent_templates SET version = 2, updated_at = now() WHERE template_key = 'property_operations_assistant'`);

    // An explicit "reset to template defaults" (the only thing that should
    // ever change sourceTemplateVersion) catches the agent up.
    const reset = await workspaceService.updateAgent(businessId, agent.id, {
      name: 'Renamed',
      sourceTemplateKey: 'property_operations_assistant',
      sourceTemplateVersion: 2,
    });
    expect(reset.sourceTemplateVersion).toBe(2);
  });

  it('accepts a real name override instead of the template default', async () => {
    await createTestSubscription(businessId, 'starter');
    const agent = await workspaceService.createAgentFromTemplate(businessId, 'personal_assistant', 'My Assistant');
    expect(agent.name).toBe('My Assistant');
  });

  it('throws not-found for an unknown template key', async () => {
    await createTestSubscription(businessId, 'starter');
    await expect(workspaceService.createAgentFromTemplate(businessId, 'not_a_real_template')).rejects.toThrow();
  });

  it('respects the exact same entitlement check as manual creation - denied with no active subscription', async () => {
    await expect(workspaceService.createAgentFromTemplate(businessId, 'personal_assistant')).rejects.toThrow();
    try {
      await workspaceService.createAgentFromTemplate(businessId, 'personal_assistant');
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) expect(error.reason).toBe('NO_ACTIVE_SUBSCRIPTION');
    }
    expect(await workspaceService.listAgents(businessId)).toEqual([]);
  });

  it('respects the same per-plan agent count limit as manual creation', async () => {
    await createTestSubscription(businessId, 'starter');
    await workspaceService.createAgentFromTemplate(businessId, 'personal_assistant');
    await workspaceService.createAgent(businessId, { name: 'Manually created' });

    await expect(workspaceService.createAgentFromTemplate(businessId, 'property_operations_assistant')).rejects.toThrow();
    try {
      await workspaceService.createAgentFromTemplate(businessId, 'property_operations_assistant');
    } catch (error) {
      expect(isEntitlementDeniedError(error)).toBe(true);
      if (isEntitlementDeniedError(error)) expect(error.reason).toBe('ENTITLEMENT_LIMIT_REACHED');
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

describe('workspaceService.assignChat (real assignment, real capacity enforcement, real tenant isolation)', () => {
  let businessId: string;
  let accountId: string;
  let ownerId: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    const owner = await register(
      { email: 'owner@example.com', password: 'correcthorsebatterystaple', displayName: 'Owner' },
      { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' },
    );
    businessId = owner.business.id;
    ownerId = owner.user.id;
    accountId = await createTestAccount(businessId);
    const created = await createMember(businessId, ownerId, { email: 'agent@example.com', displayName: 'Agent', role: 'AGENT' });
    agentId = created.member.userId;
  });

  async function makeChat(jid: string) {
    const chatRepository = new WhatsAppChatRepository(pool);
    return chatRepository.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: jid, jidKind: 'individual', chatType: 'individual' });
  }

  it('assigns a chat to a real active business member and dispatches a real ASSIGNMENT notification', async () => {
    const chat = await makeChat('15551110001@s.whatsapp.net');
    const updated = await workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: agentId, assigneeTeamId: null });
    expect(updated?.assigneeUserId).toBe(agentId);

    const { notifications } = await listNotifications(businessId, agentId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.type).toBe('ASSIGNMENT');
  });

  it('assigns a chat to a real team belonging to this business, and rejects a team from another business', async () => {
    const team = await createTeam(businessId, 'Support', null);
    const chat = await makeChat('15551110002@s.whatsapp.net');
    const updated = await workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: null, assigneeTeamId: team.id });
    expect(updated?.assigneeTeamId).toBe(team.id);

    const otherBusinessId = await createTestBusiness('Other Business');
    const otherTeam = await createTeam(otherBusinessId, 'Sales', null);
    await expect(
      workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: null, assigneeTeamId: otherTeam.id }),
    ).rejects.toThrow();
    try {
      await workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: null, assigneeTeamId: otherTeam.id });
    } catch (error) {
      expect(isInvalidAssignmentError(error)).toBe(true);
    }
  });

  it('rejects assigning to a user who is not an active member of this business', async () => {
    const chat = await makeChat('15551110003@s.whatsapp.net');
    await expect(
      workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: '00000000-0000-0000-0000-000000000000', assigneeTeamId: null }),
    ).rejects.toThrow();
    try {
      await workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: '00000000-0000-0000-0000-000000000000', assigneeTeamId: null });
    } catch (error) {
      expect(isInvalidAssignmentError(error)).toBe(true);
    }
  });

  it('enforces real agent capacity - refuses a chat once the assignee is already at their configured limit', async () => {
    await updateMyCapacity(businessId, agentId, { maxActiveConversations: 1 });

    const first = await makeChat('15551110004@s.whatsapp.net');
    await workspaceService.assignChat(businessId, accountId, first.id, { assigneeUserId: agentId, assigneeTeamId: null });

    const second = await makeChat('15551110005@s.whatsapp.net');
    await expect(
      workspaceService.assignChat(businessId, accountId, second.id, { assigneeUserId: agentId, assigneeTeamId: null }),
    ).rejects.toThrow();
    try {
      await workspaceService.assignChat(businessId, accountId, second.id, { assigneeUserId: agentId, assigneeTeamId: null });
    } catch (error) {
      expect(isCapacityExceededError(error)).toBe(true);
      if (isCapacityExceededError(error)) {
        expect(error.limit).toBe(1);
        expect(error.current).toBe(1);
      }
    }
  });

  it('re-assigning a chat that is already theirs never counts against capacity (no-op reassignment)', async () => {
    await updateMyCapacity(businessId, agentId, { maxActiveConversations: 1 });
    const chat = await makeChat('15551110006@s.whatsapp.net');
    await workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: agentId, assigneeTeamId: null });

    // Reassigning the SAME chat to the SAME agent must not be blocked by their own capacity.
    await expect(
      workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: agentId, assigneeTeamId: null }),
    ).resolves.toBeTruthy();
  });

  it('unassigning (both null) always succeeds and never dispatches an ASSIGNMENT notification', async () => {
    const chat = await makeChat('15551110007@s.whatsapp.net');
    await workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: agentId, assigneeTeamId: null });
    const unassigned = await workspaceService.assignChat(businessId, accountId, chat.id, { assigneeUserId: null, assigneeTeamId: null });
    expect(unassigned?.assigneeUserId).toBeNull();

    const { notifications } = await listNotifications(businessId, agentId);
    expect(notifications).toHaveLength(1); // only the original assignment notification, nothing for the unassign
  });

  it('throws not-found for a chat belonging to a different business', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const chat = await makeChat('15551110008@s.whatsapp.net');
    await expect(
      workspaceService.assignChat(otherBusinessId, accountId, chat.id, { assigneeUserId: null, assigneeTeamId: null }),
    ).rejects.toThrow();
    try {
      await workspaceService.assignChat(otherBusinessId, accountId, chat.id, { assigneeUserId: null, assigneeTeamId: null });
    } catch (error) {
      expect(isChatNotFoundError(error)).toBe(true);
    }
  });
});

describe('workspaceService.listMessages - group chat sender name resolution', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('resolves the real sender name per message in a group chat, correctly distinguishing two different senders', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const messageRepository = new WhatsAppMessageRepository(pool);
    const contactRepository = new WhatsAppContactRepository(pool);

    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '111222333-4444@g.us',
      jidKind: 'group',
      chatType: 'group',
    });

    const alex = await contactRepository.upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, whatsappJid: '15559990001@s.whatsapp.net', jidKind: 'individual', pushName: 'Alex',
    });
    const jordan = await contactRepository.upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, whatsappJid: '15559990002@s.whatsapp.net', jidKind: 'individual', displayName: 'Jordan Saved Name', pushName: 'jordan_push',
    });

    await messageRepository.insert({
      businessId, whatsappAccountId: accountId, chatId: chat.id,
      whatsappMessageId: 'WA-GROUP-MSG-1', remoteJid: chat.chatJid, senderJid: alex.whatsappJid, senderContactId: alex.id,
      direction: 'inbound', messageType: 'text', textContent: 'hi from alex', timestamp: new Date(Date.now() - 1000).toISOString(), fromMe: false, isHistorical: false,
    });
    await messageRepository.insert({
      businessId, whatsappAccountId: accountId, chatId: chat.id,
      whatsappMessageId: 'WA-GROUP-MSG-2', remoteJid: chat.chatJid, senderJid: jordan.whatsappJid, senderContactId: jordan.id,
      direction: 'inbound', messageType: 'text', textContent: 'hi from jordan', timestamp: new Date().toISOString(), fromMe: false, isHistorical: false,
    });

    const messages = await workspaceService.listMessages(businessId, accountId, chat.id);
    const byText = new Map(messages.map((m) => [m.textContent, m.senderName]));
    expect(byText.get('hi from alex')).toBe('Alex');
    // displayName (the saved contact name) outranks pushName in resolveDisplayName's priority.
    expect(byText.get('hi from jordan')).toBe('Jordan Saved Name');
  });

  it('never resolves a sender name for a DM - the chat itself is already the one contact, shown elsewhere in the UI', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const messageRepository = new WhatsAppMessageRepository(pool);
    const contactRepository = new WhatsAppContactRepository(pool);

    const contact = await contactRepository.upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, whatsappJid: '15559990003@s.whatsapp.net', jidKind: 'individual', pushName: 'Solo Contact',
    });
    const chat = await chatRepository.upsertFromWhatsApp({
      businessId, whatsappAccountId: accountId, chatJid: contact.whatsappJid, jidKind: 'individual', chatType: 'individual', contactId: contact.id,
    });
    await messageRepository.insert({
      businessId, whatsappAccountId: accountId, chatId: chat.id,
      whatsappMessageId: 'WA-DM-MSG-1', remoteJid: chat.chatJid, senderJid: contact.whatsappJid, senderContactId: contact.id,
      direction: 'inbound', messageType: 'text', textContent: 'hi', timestamp: new Date().toISOString(), fromMe: false, isHistorical: false,
    });

    const messages = await workspaceService.listMessages(businessId, accountId, chat.id);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.senderName).toBeNull();
  });
});
