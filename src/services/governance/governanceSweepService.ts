/**
 * AI Governance & Oversight (v1) - the scheduled sweep entry point. Turns
 * the existing security_audit_logs trail (already written by agentGuard.ts,
 * sentinel.ts, and the outbound leak guard on every real event) into a
 * genuine reviewable signal via three concrete, streamlined threshold
 * rules - NOT ML-based behavioral drift detection, NOT NIST/ISO/EU-AI-Act
 * compliance-framework mapping. See the "explicitly deferred" list in the
 * project plan for the full scope boundary.
 *
 * A real, structural guarantee, not just a scoped-down promise: this file
 * is invoked ONLY by the scheduled BullMQ job (incomingMessagesWorker.ts).
 * There is no HTTP route reachable from an AI agent's own tool-calling
 * path (agentGuard.ts / aiOrchestrator.ts) into flag creation, review, or
 * dismissal - an agent has no code path to approve or suppress its own
 * governance flag.
 */

import { pool } from '../../db/pool.js';
import { SecurityAuditLogRepository } from '../../repositories/securityAuditLogRepository.js';
import { GovernanceFlagRepository, type GovernanceFlagType } from '../../repositories/governanceFlagRepository.js';
import { getGovernanceThresholds } from '../platform/platformConfigService.js';

const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const governanceFlagRepository = new GovernanceFlagRepository(pool);

/** 30 min - tighter than the hourly security-scan sweep, since two sweeps per rolling window catches a real spike roughly mid-window rather than up to an hour late, while still cheap (a handful of GROUP BY queries every 30 min is negligible load). */
export const GOVERNANCE_SWEEP_INTERVAL_MS = 1_800_000;

const WINDOW_MS = 60 * 60 * 1000; // 1 hour, matching the thresholds being expressed "per hour"

/**
 * De-duplication: before creating a flag for a given (business, agent,
 * flagType), skip if an OPEN flag of that exact type already exists - the
 * existing open flag already represents "this is still a problem," and a
 * developer reviewing/dismissing it is the explicit signal that it's safe
 * to raise a fresh one on a later sweep if the condition still holds. No
 * separate time-based cooldown is needed on top of this.
 */
async function raiseIfNew(input: {
  businessId: string;
  agentId: string | null;
  flagType: GovernanceFlagType;
  severity: 'info' | 'warning' | 'critical';
  metricValue: number;
  thresholdValue: number;
  windowStart: string;
  windowEnd: string;
}): Promise<void> {
  const existing = await governanceFlagRepository.findOpenByBusinessAgentAndType(input.businessId, input.agentId, input.flagType);
  if (existing) return;

  const flag = await governanceFlagRepository.create(input);
  await securityAuditLogRepository
    .record({
      businessId: input.businessId,
      eventType: 'governance_flag_raised',
      severity: input.severity,
      rawMetadata: { flagId: flag.id, flagType: flag.flagType, agentId: input.agentId },
    })
    .catch((error) => console.error('[governanceSweepService] Failed to record governance_flag_raised audit event:', error instanceof Error ? error.message : error));
}

export async function runGovernanceSweep(): Promise<void> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - WINDOW_MS);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();
  const thresholds = await getGovernanceThresholds();

  // Rule 1: high_tool_denial_rate, per (business, agent).
  const denied = await securityAuditLogRepository.countGroupedByAgentSince('ai_tool_denied', windowStartIso);
  for (const { businessId, agentId, count } of denied) {
    if (count < thresholds.toolDenialsPerHour) continue;
    await raiseIfNew({
      businessId, agentId, flagType: 'high_tool_denial_rate', severity: 'warning',
      metricValue: count, thresholdValue: thresholds.toolDenialsPerHour,
      windowStart: windowStartIso, windowEnd: windowEndIso,
    });
  }

  // Rule 2: high_sentinel_block_rate, per business only (Sentinel never records an agentId).
  const sentinelBlocked = await securityAuditLogRepository.countGroupedByBusinessSince(['sentinel_heuristic_block', 'sentinel_ai_block'], windowStartIso);
  for (const { businessId, count } of sentinelBlocked) {
    if (count < thresholds.sentinelBlocksPerHour) continue;
    await raiseIfNew({
      businessId, agentId: null, flagType: 'high_sentinel_block_rate', severity: 'warning',
      metricValue: count, thresholdValue: thresholds.sentinelBlocksPerHour,
      windowStart: windowStartIso, windowEnd: windowEndIso,
    });
  }

  // Rule 3: high_output_leak_rate, per business only - critical, since a
  // leak reaching this check already got past generation (the most severe
  // of the three signals).
  const leaks = await securityAuditLogRepository.countGroupedByBusinessSince(['ai_output_leak_blocked'], windowStartIso);
  for (const { businessId, count } of leaks) {
    if (count < thresholds.outputLeaksPerHour) continue;
    await raiseIfNew({
      businessId, agentId: null, flagType: 'high_output_leak_rate', severity: 'critical',
      metricValue: count, thresholdValue: thresholds.outputLeaksPerHour,
      windowStart: windowStartIso, windowEnd: windowEndIso,
    });
  }

  // Rule 4 (follow-up): high_agent_output_leak_rate, per (business, agent) -
  // reuses countGroupedByAgentSince unchanged, since guardGeneratedText
  // (aiOrchestrator.ts) already records agentId on every ai_output_leak_blocked
  // event. Also critical - a specific agent repeatedly leaking is at least
  // as severe as the business-wide rule above.
  const agentLeaks = await securityAuditLogRepository.countGroupedByAgentSince('ai_output_leak_blocked', windowStartIso);
  for (const { businessId, agentId, count } of agentLeaks) {
    if (count < thresholds.outputLeaksPerAgentPerHour) continue;
    await raiseIfNew({
      businessId, agentId, flagType: 'high_agent_output_leak_rate', severity: 'critical',
      metricValue: count, thresholdValue: thresholds.outputLeaksPerAgentPerHour,
      windowStart: windowStartIso, windowEnd: windowEndIso,
    });
  }
}
