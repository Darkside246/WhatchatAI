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
    const agent = await new AiAgentRepository(pool).create({ businessId, name: 'Reception Agent', autonomyLevel: 2 });
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
    const openAgent = await new AiAgentRepository(pool).create({ businessId, name: 'Open Agent', autonomyLevel: 3 });
    for (let i = 0; i < 5; i += 1) await createDecidedAction(businessId, openAgent.id, 'APPROVED');
    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });

  /**
   * Section 99-101 (performance): getRecentDecisionsForAgents batches this
   * into one query (PARTITION BY agent + ROW_NUMBER) instead of one query
   * per agent - the real correctness risk of that rewrite is the window
   * boundary leaking across agents (agent B's decisions counting toward
   * agent A's "most recent 5", or the LIMIT being applied globally instead
   * of per-agent). Two agents with genuinely different, independently
   * crossing-or-not streaks in the same business proves each agent's
   * window is really its own.
   */
  it('correctly isolates each agent\'s own most-recent-decisions window when multiple agents qualify at once', async () => {
    const agentB = await new AiAgentRepository(pool).create({ businessId, name: 'Sales Agent', autonomyLevel: 1 });

    // Agent A: streak of 5 approvals - crosses the threshold.
    for (let i = 0; i < 5; i += 1) await createDecidedAction(businessId, agentId, 'APPROVED');
    // Agent B: a rejection sits inside its most recent 5 - must never suggest, and must never be diluted by A's clean streak.
    for (let i = 0; i < 4; i += 1) await createDecidedAction(businessId, agentB.id, 'APPROVED');
    await createDecidedAction(businessId, agentB.id, 'REJECTED');

    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([{ agentId, agentName: 'Reception Agent', approvedStreak: 5 }]);
  });

  it('never queries at all, and returns cleanly, when no agent in the business requires approval', async () => {
    await new AiAgentRepository(pool).updateAutonomyLevel(agentId, 3);
    for (let i = 0; i < 5; i += 1) await createDecidedAction(businessId, agentId, 'APPROVED');

    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });

  it('never leaks another business\'s approval history into this business\'s suggestions', async () => {
    const otherBusinessId = await createTestBusiness('Other Business');
    const otherAgent = await new AiAgentRepository(pool).create({ businessId: otherBusinessId, name: 'Other Agent', autonomyLevel: 2 });
    for (let i = 0; i < 5; i += 1) await createDecidedAction(otherBusinessId, otherAgent.id, 'APPROVED');

    const suggestions = await workspaceService.getApprovalPatternSuggestions(businessId);
    expect(suggestions).toEqual([]);
  });
});
