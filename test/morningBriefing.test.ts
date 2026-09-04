import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { PlatformActionRepository } from '../src/repositories/platformActionRepository.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { SecurityAuditLogRepository } from '../src/repositories/securityAuditLogRepository.js';
import { LeadRepository } from '../src/repositories/leadRepository.js';
import { CrmContactRepository } from '../src/repositories/crmContactRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { AgentWorkJournalRepository } from '../src/repositories/agentWorkJournalRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const chatRepo = new WhatsAppChatRepository(pool);
const actionRepo = new PlatformActionRepository(pool);
const agentRepo = new AiAgentRepository(pool);
const auditRepo = new SecurityAuditLogRepository(pool);
const leadRepo = new LeadRepository(pool);
const crmContactRepo = new CrmContactRepository(pool);
const waContactRepo = new WhatsAppContactRepository(pool);
const journalRepo = new AgentWorkJournalRepository(pool);

describe('workspaceService.getMorningBriefing (real Postgres, real aggregation)', () => {
  let businessId: string;
  let accountId: string;
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 1 hour ago

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  it('returns a real, all-empty briefing when nothing has happened', async () => {
    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.completedActions).toEqual([]);
    expect(briefing.failedActions).toEqual([]);
    expect(briefing.pendingApprovals).toEqual([]);
    expect(briefing.riskFlags).toEqual([]);
    expect(briefing.chatsNeedingHuman).toEqual([]);
    expect(briefing.newAppointments).toEqual([]);
    expect(briefing.newLeads).toEqual([]);
    expect(briefing.sinceIso).toBe(sinceIso);
    expect(briefing.autonomousActivity).toEqual({ FINDING: 0, ACTION_TAKEN: 0, QUEUED_FOR_APPROVAL: 0, SKIPPED: 0 });
  });

  it('"While You Were Away" (Section 41-42 Phase 1) surfaces real counts from the autonomous sweep\'s own work journal, never fabricated', async () => {
    await journalRepo.record({ businessId, agentId: null, entryType: 'ACTION_TAKEN', summary: 'Created a follow-up reminder' });
    await journalRepo.record({ businessId, agentId: null, entryType: 'ACTION_TAKEN', summary: 'Created a follow-up reminder' });
    await journalRepo.record({ businessId, agentId: null, entryType: 'FINDING', summary: 'Would have created a reminder' });

    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.autonomousActivity).toEqual({ FINDING: 1, ACTION_TAKEN: 2, QUEUED_FOR_APPROVAL: 0, SKIPPED: 0 });
  });

  it('surfaces a real completed action that occurred since sinceIso', async () => {
    const agent = await agentRepo.create({ businessId, name: 'Reception Agent' });
    const recent = await actionRepo.create({
      id: randomUUID(), businessId, type: 'meeting.schedule_google_meet', payload: {}, requestedByKind: 'AGENT', requestedById: agent.id,
      riskLevel: 'MEDIUM', approvalRequired: false, approvalStatus: 'NOT_REQUIRED', status: 'SUCCEEDED',
      idempotencyKey: `test-${randomUUID()}`, correlationId: randomUUID(), executionResult: null, executionError: null,
    });

    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.completedActions.map((a) => a.id)).toEqual([recent.id]);
  });

  it('excludes an action whose last update predates sinceIso - real boundary, not just "everything ever"', async () => {
    // platform_action_requests has a real BEFORE UPDATE trigger
    // (platform_touch_updated_at) that always sets updated_at = now() -
    // correct production behavior, but it means a test can't backdate an
    // existing row's updated_at directly. Proven instead from the other
    // direction: a sinceIso set in the future can have nothing genuinely
    // on-or-after it yet.
    const agent = await agentRepo.create({ businessId, name: 'Reception Agent' });
    await actionRepo.create({
      id: randomUUID(), businessId, type: 'meeting.schedule_google_meet', payload: {}, requestedByKind: 'AGENT', requestedById: agent.id,
      riskLevel: 'MEDIUM', approvalRequired: false, approvalStatus: 'NOT_REQUIRED', status: 'SUCCEEDED',
      idempotencyKey: `test-${randomUUID()}`, correlationId: randomUUID(), executionResult: null, executionError: null,
    });
    const futureSinceIso = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const briefing = await workspaceService.getMorningBriefing(businessId, futureSinceIso);
    expect(briefing.completedActions).toEqual([]);
  });

  it('surfaces a real failed action separately from completed ones', async () => {
    const agent = await agentRepo.create({ businessId, name: 'Reception Agent' });
    await actionRepo.create({
      id: randomUUID(), businessId, type: 'meeting.schedule_zoom_meeting', payload: {}, requestedByKind: 'AGENT', requestedById: agent.id,
      riskLevel: 'MEDIUM', approvalRequired: false, approvalStatus: 'NOT_REQUIRED', status: 'FAILED',
      idempotencyKey: `test-${randomUUID()}`, correlationId: randomUUID(), executionResult: null, executionError: 'zoom_api_error',
    });

    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.failedActions).toHaveLength(1);
    expect(briefing.completedActions).toHaveLength(0);
  });

  it('surfaces a real message_risk_flagged event since sinceIso', async () => {
    await auditRepo.record({
      businessId, whatsappAccountId: accountId, eventType: 'message_risk_flagged', severity: 'warning',
      reason: 'Inbound message classified as "complaint" (risk 3)', rawMetadata: { intent: 'complaint', riskLevel: 3 },
    });

    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.riskFlags).toHaveLength(1);
    expect(briefing.riskFlags[0]?.reason).toContain('complaint');
  });

  it('surfaces a real new lead created since sinceIso', async () => {
    const waContact = await waContactRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, whatsappJid: '15550009999@s.whatsapp.net', jidKind: 'individual', displayName: 'New Prospect' });
    const crmContact = await crmContactRepo.upsertForWhatsAppContact({ businessId, whatsappContactId: waContact.id });
    await leadRepo.create({ businessId, crmContactId: crmContact.id, source: 'whatsapp', stage: 'new_enquiry' });

    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.newLeads).toHaveLength(1);
    expect(briefing.newLeads[0]?.contactDisplayName).toBe('New Prospect');
  });

  it('surfaces real chats needing a human takeover, same signal as getNextBestActions', async () => {
    const chat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: '15550001111@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', name: 'Waiting Customer' });
    await chatRepo.setAiMode(chat.id, 'HUMAN_TAKEOVER', 'manual_reply_detected');

    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.chatsNeedingHuman).toHaveLength(1);
    expect(briefing.chatsNeedingHuman[0]?.displayName).toBe('Waiting Customer');
  });

  it('reuses the exact same recommendedPriorities as getNextBestActions - no second, drifting implementation', async () => {
    const chat = await chatRepo.upsertFromWhatsApp({ businessId, whatsappAccountId: accountId, chatJid: '15550002222@s.whatsapp.net', jidKind: 'individual', chatType: 'individual', name: 'A Customer' });
    await chatRepo.setAiMode(chat.id, 'HUMAN_TAKEOVER', 'manual_reply_detected');

    const [briefing, nba] = await Promise.all([
      workspaceService.getMorningBriefing(businessId, sinceIso),
      workspaceService.getNextBestActions(businessId),
    ]);
    expect(briefing.recommendedPriorities.map((a) => a.id)).toEqual(nba.map((a) => a.id));
  });

  it('never leaks another business\'s activity into this business\'s briefing', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAccountId = await createTestAccount(otherBusinessId, '15550003333@s.whatsapp.net');
    const otherChat = await chatRepo.upsertFromWhatsApp({ businessId: otherBusinessId, whatsappAccountId: otherAccountId, chatJid: '15550003333@s.whatsapp.net', jidKind: 'individual', chatType: 'individual' });
    await chatRepo.setAiMode(otherChat.id, 'HUMAN_TAKEOVER', 'manual_reply_detected');
    await auditRepo.record({ businessId: otherBusinessId, whatsappAccountId: otherAccountId, eventType: 'message_risk_flagged', severity: 'warning', reason: 'other business', rawMetadata: {} });
    await journalRepo.record({ businessId: otherBusinessId, agentId: null, entryType: 'ACTION_TAKEN', summary: 'other business action' });

    const briefing = await workspaceService.getMorningBriefing(businessId, sinceIso);
    expect(briefing.chatsNeedingHuman).toEqual([]);
    expect(briefing.riskFlags).toEqual([]);
    expect(briefing.autonomousActivity).toEqual({ FINDING: 0, ACTION_TAKEN: 0, QUEUED_FOR_APPROVAL: 0, SKIPPED: 0 });
  });
});
