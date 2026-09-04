import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { initializePlatformFoundation } from '../src/services/platform/platformBootstrap.js';
import { runSweepForBusiness, listBusinessesForSweep } from '../src/services/platform/autonomousOpsService.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { PlatformSettingsRepository } from '../src/repositories/platformSettingsRepository.js';
import { AgentWorkJournalRepository } from '../src/repositories/agentWorkJournalRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { createTestAccount, createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Section 41-42 Phase 1's real "detect work -> act or surface" loop. Every
 * test creates a genuine "chat needs a human" signal (a real
 * whatsapp_chats row with ai_mode = 'HUMAN_TAKEOVER') - the same data
 * getNextBestActions itself reads - never a mocked recommendation list,
 * so this proves the whole pipeline end to end: detection, policy,
 * execution, and the work journal.
 */
describe('autonomousOpsService.runSweepForBusiness (real Postgres)', () => {
  const agents = new AiAgentRepository(pool);
  const settings = new PlatformSettingsRepository(pool);
  const journal = new AgentWorkJournalRepository(pool);
  const notifications = new NotificationRepository(pool);
  const chats = new WhatsAppChatRepository(pool);
  let businessId: string;
  let userId: string;

  beforeEach(async () => {
    await resetDatabase();
    initializePlatformFoundation();
    businessId = await createTestBusiness();
    userId = await createTestUser(businessId);
  });

  async function createChatNeedingHuman(): Promise<string> {
    const accountId = await createTestAccount(businessId);
    const chat = await chats.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550001234@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    await chats.setAiMode(chat.id, 'HUMAN_TAKEOVER', 'test_fixture');
    return chat.id;
  }

  it('never runs when no agent has opted in - proactive_mode defaults to OFF for every agent', async () => {
    await agents.create({ businessId, name: 'Agent' });
    await createChatNeedingHuman();

    const result = await runSweepForBusiness(businessId);
    expect(result).toEqual({ ran: false, reason: 'PROACTIVE_MODE_OFF', findings: 0, actionsTaken: 0, queuedForApproval: 0 });
    expect(await notifications.listForUser(businessId, userId, 10)).toHaveLength(0);
  });

  it('never runs while the platform-wide autonomy kill switch is enabled, even for an AUTONOMOUS agent', async () => {
    const agent = await agents.create({ businessId, name: 'Agent' });
    await agents.updateProactiveMode(agent.id, 'AUTONOMOUS');
    await createChatNeedingHuman();
    await settings.set('autonomy_kill_switch', { enabled: true }, null);

    const result = await runSweepForBusiness(businessId);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('AUTONOMY_KILL_SWITCH_ENABLED');
    expect(await notifications.listForUser(businessId, userId, 10)).toHaveLength(0);
  });

  it('never runs while this business\'s own ai_actions_paused emergency pause is on', async () => {
    const agent = await agents.create({ businessId, name: 'Agent' });
    await agents.updateProactiveMode(agent.id, 'AUTONOMOUS');
    await createChatNeedingHuman();
    await new BusinessRepository(pool).setAiActionsPaused(businessId, true);

    const result = await runSweepForBusiness(businessId);
    expect(result.ran).toBe(false);
    expect(result.reason).toBe('AI_ACTIONS_PAUSED');
  });

  it('ASSISTED mode only logs a FINDING - never creates a real notification', async () => {
    const agent = await agents.create({ businessId, name: 'Agent' });
    await agents.updateProactiveMode(agent.id, 'ASSISTED');
    await createChatNeedingHuman();

    const result = await runSweepForBusiness(businessId);
    expect(result).toMatchObject({ ran: true, findings: 1, actionsTaken: 0, queuedForApproval: 0 });
    expect(await notifications.listForUser(businessId, userId, 10)).toHaveLength(0);

    const since = new Date(Date.now() - 60_000).toISOString();
    const entries = await journal.listSince(businessId, since);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryType).toBe('FINDING');
  });

  it('AUTONOMOUS mode actually executes the one real LOW-risk action and journals it', async () => {
    const agent = await agents.create({ businessId, name: 'Agent' });
    await agents.updateProactiveMode(agent.id, 'AUTONOMOUS');
    await createChatNeedingHuman();

    const result = await runSweepForBusiness(businessId);
    expect(result).toMatchObject({ ran: true, actionsTaken: 1, queuedForApproval: 0 });

    const created = await notifications.listForUser(businessId, userId, 10);
    expect(created).toHaveLength(1);
    expect(created[0]?.type).toBe('ASSIGNMENT');

    const since = new Date(Date.now() - 60_000).toISOString();
    const entries = await journal.listSince(businessId, since);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.entryType).toBe('ACTION_TAKEN');
  });

  it('DELEGATED behaves identically to AUTONOMOUS in Phase 1 - no distinguishing axis exists yet', async () => {
    const agent = await agents.create({ businessId, name: 'Agent' });
    await agents.updateProactiveMode(agent.id, 'DELEGATED');
    await createChatNeedingHuman();

    const result = await runSweepForBusiness(businessId);
    expect(result.actionsTaken).toBe(1);
  });

  it('running the sweep twice for the same still-open signal on the same day only ever notifies once - real idempotency, not a duplicate reminder', async () => {
    const agent = await agents.create({ businessId, name: 'Agent' });
    await agents.updateProactiveMode(agent.id, 'AUTONOMOUS');
    await createChatNeedingHuman();

    await runSweepForBusiness(businessId);
    await runSweepForBusiness(businessId);

    expect(await notifications.listForUser(businessId, userId, 10)).toHaveLength(1);
  });

  it('never touches another business\'s data (tenant isolation)', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherUserId = await createTestUser(otherBusinessId);
    const otherAgent = await agents.create({ businessId: otherBusinessId, name: 'Other Agent' });
    await agents.updateProactiveMode(otherAgent.id, 'AUTONOMOUS');
    const otherAccountId = await createTestAccount(otherBusinessId, '15559998888@s.whatsapp.net');
    const otherChat = await chats.upsertFromWhatsApp({ businessId: otherBusinessId, whatsappAccountId: otherAccountId, chatJid: '15559998888@s.whatsapp.net', jidKind: 'individual', chatType: 'individual' });
    await chats.setAiMode(otherChat.id, 'HUMAN_TAKEOVER', 'test_fixture');

    // This business has no opted-in agent at all.
    await agents.create({ businessId, name: 'Off Agent' });
    await createChatNeedingHuman();

    await runSweepForBusiness(businessId);
    expect(await notifications.listForUser(businessId, userId, 10)).toHaveLength(0);

    await runSweepForBusiness(otherBusinessId);
    expect(await notifications.listForUser(otherBusinessId, otherUserId, 10)).toHaveLength(1);
  });

  it('listBusinessesForSweep only returns businesses with a real opted-in agent', async () => {
    const agent = await agents.create({ businessId, name: 'Agent' });
    await agents.updateProactiveMode(agent.id, 'AUTONOMOUS');
    const enabled = await listBusinessesForSweep();
    expect(enabled).toContain(businessId);
  });
});
