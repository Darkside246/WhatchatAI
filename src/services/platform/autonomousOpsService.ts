import { randomUUID } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { BusinessRepository } from '../../repositories/businessRepository.js';
import { AiAgentRepository } from '../../repositories/aiAgentRepository.js';
import { PlatformSettingsRepository } from '../../repositories/platformSettingsRepository.js';
import { AgentWorkJournalRepository } from '../../repositories/agentWorkJournalRepository.js';
import { ApprovalService } from './approvalService.js';
import { actionBusService } from './actionBusService.js';
import { AUTONOMOUS_CREATE_REMINDER_ACTION_TYPE } from './createFollowUpReminderExecutor.js';
import { workspaceService, type NextBestAction } from '../workspaceService.js';
import type { ActionRequest, AgentCapability } from '../../domain/platform/contracts.js';

const businessRepository = new BusinessRepository(pool);
const aiAgentRepository = new AiAgentRepository(pool);
const platformSettingsRepository = new PlatformSettingsRepository(pool);
const journalRepository = new AgentWorkJournalRepository(pool);
const approvalService = new ApprovalService(pool);

const AUTONOMOUS_SWEEP_AGENT_ID = 'autonomous-ops-sweep';

/** A synthetic capability scoped to exactly the one action this sweep may take unsupervised - mirrors platformApprovalRouter.ts's humanApprovalCapability, same reasoning: a real per-dispatch authority, not a stored, broader-than-needed row. */
function autonomousSweepCapability(actionType: string): AgentCapability {
  return {
    id: `autonomous-sweep:${actionType}`,
    agentId: AUTONOMOUS_SWEEP_AGENT_ID,
    description: 'Section 41-42 Phase 1 autonomous sweep - scoped to exactly the one LOW-risk action type it may execute unsupervised.',
    allowedActions: [actionType],
    forbiddenActions: [],
    requiresApprovalFor: [],
    maxRiskLevel: 'LOW',
  };
}

/**
 * Every next-best-action recommendation becomes a candidate for exactly
 * one real, safe, internal action - a staff notification, never a
 * customer-facing message, booking, or order (see autonomousOpsService.ts's
 * own module doc). Bucketed by the sweep's own run date so a still-open
 * situation gets a fresh nudge once a day rather than either spamming
 * every sweep interval or permanently going silent after the first one
 * (the same staleness trap a stale idempotency guard can fall into
 * elsewhere in this codebase).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * NextBestAction.id is always "<prefix>:<real underlying UUID>" (e.g.
 * "chat:<chatId>", "invoice:<invoiceId>") - this recovers that real entity
 * reference for notifications.target_type/target_id (a real UUID column,
 * unlike NextBestAction.link, which is a frontend route path and would
 * fail that column's type check outright - a real bug caught by this
 * file's own test suite, not by inspection). Falls back to no target
 * rather than guessing if a future NextBestAction type ever breaks the
 * convention.
 */
function extractTarget(nextBestActionId: string): { targetType: string | null; targetId: string | null } {
  const [prefix, ...rest] = nextBestActionId.split(':');
  const id = rest.join(':');
  if (!prefix || !UUID_PATTERN.test(id)) return { targetType: null, targetId: null };
  return { targetType: prefix, targetId: id };
}

function buildReminderAction(businessId: string, nextBestAction: NextBestAction): ActionRequest {
  const correlationId = randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const { targetType, targetId } = extractTarget(nextBestAction.id);
  return {
    id: randomUUID(),
    tenantId: businessId,
    type: AUTONOMOUS_CREATE_REMINDER_ACTION_TYPE,
    payload: {
      title: nextBestAction.title,
      summary: nextBestAction.description,
      targetType,
      targetId,
      sourceType: nextBestAction.type,
      link: nextBestAction.link,
    },
    requestedBy: { kind: 'AGENT', id: AUTONOMOUS_SWEEP_AGENT_ID },
    riskLevel: 'LOW',
    approval: { required: false, status: 'NOT_REQUIRED' },
    status: 'READY',
    idempotencyKey: `${nextBestAction.id}:${today}`,
    correlationId,
    createdAt: new Date().toISOString(),
  };
}

export interface SweepResult {
  ran: boolean;
  reason?: string;
  findings: number;
  actionsTaken: number;
  queuedForApproval: number;
}

/**
 * Section 41-42 Phase 1's real "detect work -> act or surface" loop for
 * one business - the buildable core of the user's much larger autonomous-
 * operations specification. Three real gates, cheapest first: the
 * platform-wide developer kill switch, the business's own existing
 * ai_actions_paused emergency pause (reused, not duplicated), and whether
 * any of this business's agents have opted into proactive work at all.
 * Deliberately reuses existing, already-tested infrastructure throughout -
 * getNextBestActions for "detect work", evaluateActionPolicy (via
 * actionBusService) for the risk/approval decision, ApprovalService for
 * anything that needs a human - no new risk engine, no new approval
 * system.
 */
export async function runSweepForBusiness(businessId: string): Promise<SweepResult> {
  const killSwitch = await platformSettingsRepository.get('autonomy_kill_switch');
  if (killSwitch && (killSwitch.value as { enabled?: unknown }).enabled === true) {
    return { ran: false, reason: 'AUTONOMY_KILL_SWITCH_ENABLED', findings: 0, actionsTaken: 0, queuedForApproval: 0 };
  }

  const business = await businessRepository.findById(businessId);
  if (!business) return { ran: false, reason: 'BUSINESS_NOT_FOUND', findings: 0, actionsTaken: 0, queuedForApproval: 0 };
  if (business.aiActionsPaused) return { ran: false, reason: 'AI_ACTIONS_PAUSED', findings: 0, actionsTaken: 0, queuedForApproval: 0 };

  const mode = await aiAgentRepository.getMostPermissiveProactiveMode(businessId);
  if (mode === 'OFF') return { ran: false, reason: 'PROACTIVE_MODE_OFF', findings: 0, actionsTaken: 0, queuedForApproval: 0 };

  const recommendations = await workspaceService.getNextBestActions(businessId, 25);

  let findings = 0;
  let actionsTaken = 0;
  let queuedForApproval = 0;

  for (const recommendation of recommendations) {
    const action = buildReminderAction(businessId, recommendation);

    if (mode === 'ASSISTED') {
      await journalRepository.record({
        businessId,
        agentId: null,
        entryType: 'FINDING',
        summary: `Would have created a follow-up reminder: ${recommendation.title}`,
        detail: { nextBestActionId: recommendation.id, nextBestActionType: recommendation.type },
      });
      findings += 1;
      continue;
    }

    await approvalService.persistAction(action);
    const dispatch = await actionBusService.execute(action, autonomousSweepCapability(action.type), {
      tenantId: businessId,
      actorId: AUTONOMOUS_SWEEP_AGENT_ID,
    });

    if (dispatch.status === 'AWAITING_APPROVAL') {
      await journalRepository.record({
        businessId,
        agentId: null,
        entryType: 'QUEUED_FOR_APPROVAL',
        summary: `Queued for approval: ${recommendation.title}`,
        detail: { nextBestActionId: recommendation.id, actionId: action.id },
      });
      queuedForApproval += 1;
    } else if (dispatch.status === 'SUCCEEDED') {
      await journalRepository.record({
        businessId,
        agentId: null,
        entryType: 'ACTION_TAKEN',
        summary: `Created a follow-up reminder: ${recommendation.title}`,
        detail: { nextBestActionId: recommendation.id, actionId: action.id },
      });
      actionsTaken += 1;
    }
    // DENIED/FAILED are not journaled as a distinct entry type in Phase 1 -
    // FAILED already writes a real audit-ledger entry inside actionBusService
    // itself, and a repeat-run DENIED (already handled today) is expected,
    // silent idempotency working as designed, not a new event worth a row.
  }

  return { ran: true, findings, actionsTaken, queuedForApproval };
}

/** Every business currently opted into the sweep - what the recurring BullMQ job iterates. */
export async function listBusinessesForSweep(): Promise<string[]> {
  return aiAgentRepository.listBusinessIdsWithProactiveModeEnabled();
}
