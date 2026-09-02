import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { AiAgentRepository } from '../src/repositories/aiAgentRepository.js';
import { PlatformActionRepository } from '../src/repositories/platformActionRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

const actionRepository = new PlatformActionRepository(pool);

/** Creates and decides one real platform_action_requests/platform_approvals pair for an agent - the raw material the pattern-detection logic aggregates over. */
async function createDecidedAction(businessId: string, agentId: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
  const id = randomUUID();
  const row = await actionRepository.create({
    id,
    businessId,
    type: 'meeting.schedule_google_meet',
    payload: {},
    requestedByKind: 'AGENT',
    requestedById: agentId,
    riskLevel: 'MEDIUM',
    approvalRequired: true,
    approvalStatus: 'PENDING',
    status: 'PENDING_APPROVAL',
    idempotencyKey: `test-${randomUUID()}`,
    correlationId: randomUUID(),
    executionResult: null,
    executionError: null,
  });
  await actionRepository.createApproval({ id: randomUUID(), actionRequestId: row.id, businessId });
  await actionRepository.decideApproval(businessId, row.id, randomUUID(), decision);
}

describe('workspaceService.getApprovalPatternSuggestions (real Postgres)', () => {
  let businessId: string;
  let agentId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent', requiresApprovalForActions: true });
    agentId = agent.id;
    process.env.APPROVAL_PATTERN_THRESHOLD = '5';
  });

  afterEach(() => {
    delete process.env.APPROVAL_PATTERN_THRESHOLD;
  });

  it('suggests nothing when there is no real approval history yet', async () => {
    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });

  it('suggests nothing below the real decided-decision threshold, even if all approved so far', async () => {
    for (let i = 0; i < 4; i += 1) await createDecidedAction(businessId, agentId, 'APPROVED');
    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });

  it('suggests turning off approval once a real streak of all-approved decisions meets the threshold', async () => {
    for (let i = 0; i < 5; i += 1) await createDecidedAction(businessId, agentId, 'APPROVED');
    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([{ agentId, agentName: 'Reception Agent', approvedStreak: 5 }]);
  });

  it('never suggests once a real rejection appears anywhere in the recent window - a single rejection breaks the whole streak', async () => {
    for (let i = 0; i < 4; i += 1) await createDecidedAction(businessId, agentId, 'APPROVED');
    await createDecidedAction(businessId, agentId, 'REJECTED');
    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });

  it('never suggests for an agent that does not require approval in the first place', async () => {
    const openAgent = await new AiAgentRepository(pool).create({ businessId, name: 'Open Agent', requiresApprovalForActions: false });
    for (let i = 0; i < 5; i += 1) await createDecidedAction(businessId, openAgent.id, 'APPROVED');
    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });

  it('never leaks another business\'s approval history into this business\'s suggestions', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAgent = await new AiAgentRepository(pool).create({ businessId: otherBusinessId, name: 'Other Agent', requiresApprovalForActions: true });
    for (let i = 0; i < 5; i += 1) await createDecidedAction(otherBusinessId, otherAgent.id, 'APPROVED');

    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });
});
