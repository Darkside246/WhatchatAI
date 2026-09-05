import type { Queryable } from './types.js';
import type { SecuritySeverity } from './securityAuditLogRepository.js';

export type GovernanceFlagType = 'high_tool_denial_rate' | 'high_sentinel_block_rate' | 'high_output_leak_rate' | 'high_agent_output_leak_rate';
export type GovernanceFlagStatus = 'open' | 'reviewed' | 'dismissed';

export interface GovernanceFlagRecord {
  id: string;
  businessId: string | null;
  agentId: string | null;
  flagType: GovernanceFlagType;
  severity: SecuritySeverity;
  metricValue: number;
  thresholdValue: number;
  windowStart: string;
  windowEnd: string;
  status: GovernanceFlagStatus;
  reviewedByUserId: string | null;
  reviewedAt: string | null;
  createdAt: string;
  /** Only populated by listOpenAcrossPlatform's server-side join - null everywhere else. */
  businessName?: string | null;
  agentName?: string | null;
}

interface GovernanceFlagRow {
  id: string;
  business_id: string | null;
  agent_id: string | null;
  flag_type: GovernanceFlagType;
  severity: SecuritySeverity;
  metric_value: string;
  threshold_value: string;
  window_start: string;
  window_end: string;
  status: GovernanceFlagStatus;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  created_at: string;
  business_name?: string | null;
  agent_name?: string | null;
}

function toRecord(row: GovernanceFlagRow): GovernanceFlagRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    agentId: row.agent_id,
    flagType: row.flag_type,
    severity: row.severity,
    metricValue: Number(row.metric_value),
    thresholdValue: Number(row.threshold_value),
    windowStart: row.window_start,
    windowEnd: row.window_end,
    status: row.status,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    ...(row.business_name !== undefined ? { businessName: row.business_name } : {}),
    ...(row.agent_name !== undefined ? { agentName: row.agent_name } : {}),
  };
}

export interface CreateGovernanceFlagInput {
  businessId: string | null;
  agentId: string | null;
  flagType: GovernanceFlagType;
  severity: SecuritySeverity;
  metricValue: number;
  thresholdValue: number;
  windowStart: string;
  windowEnd: string;
}

/**
 * AI Governance & Oversight (v1): threshold-rule flags computed by
 * governanceSweepService.ts from the existing security_audit_logs trail.
 * RLS'd (migration 998) - tenant-scoped methods always take
 * queryAsTenant(businessId); listOpenAcrossPlatform is the one deliberate
 * bare-pool exception (the developer dashboard's cross-business view),
 * mirroring SecurityAuditLogRepository.listPlatformEvents's own precedent.
 */
export class GovernanceFlagRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateGovernanceFlagInput): Promise<GovernanceFlagRecord> {
    const { rows } = await this.db.query<GovernanceFlagRow>(
      `INSERT INTO governance_flags (business_id, agent_id, flag_type, severity, metric_value, threshold_value, window_start, window_end)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [input.businessId, input.agentId, input.flagType, input.severity, input.metricValue, input.thresholdValue, input.windowStart, input.windowEnd],
    );
    const row = rows[0];
    if (!row) throw new Error('governance_flags insert returned no row');
    return toRecord(row);
  }

  /** Bare-pool, the one deliberate tenant-agnostic method - the developer dashboard's own cross-business view. Joins businesses/ai_agents server-side so the frontend never needs a second name lookup. */
  async listOpenAcrossPlatform(limit = 100): Promise<GovernanceFlagRecord[]> {
    const { rows } = await this.db.query<GovernanceFlagRow>(
      `SELECT gf.*, b.name AS business_name, a.name AS agent_name
       FROM governance_flags gf
       LEFT JOIN businesses b ON b.id = gf.business_id
       LEFT JOIN ai_agents a ON a.id = gf.agent_id
       WHERE gf.status = 'open'
       ORDER BY gf.created_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map(toRecord);
  }

  async listForBusiness(businessId: string, limit = 50): Promise<GovernanceFlagRecord[]> {
    const { rows } = await this.db.query<GovernanceFlagRow>(
      `SELECT * FROM governance_flags WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [businessId, limit],
    );
    return rows.map(toRecord);
  }

  /** Conditional UPDATE, mirrors aiAgentPromptOptimizationRepository's markApproved/markRejected shape - null if the flag isn't 'open' (already resolved), never silently reopens or overwrites. */
  async markReviewed(id: string, reviewedByUserId: string): Promise<GovernanceFlagRecord | null> {
    const { rows } = await this.db.query<GovernanceFlagRow>(
      `UPDATE governance_flags SET status = 'reviewed', reviewed_by_user_id = $2, reviewed_at = now() WHERE id = $1 AND status = 'open' RETURNING *`,
      [id, reviewedByUserId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async markDismissed(id: string, reviewedByUserId: string): Promise<GovernanceFlagRecord | null> {
    const { rows } = await this.db.query<GovernanceFlagRow>(
      `UPDATE governance_flags SET status = 'dismissed', reviewed_by_user_id = $2, reviewed_at = now() WHERE id = $1 AND status = 'open' RETURNING *`,
      [id, reviewedByUserId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The sweep's own de-dup lookup - never create a second open flag of the same type for the same business+agent while one is already open. Bare-pool since the sweep itself scans platform-wide. */
  async findOpenByBusinessAgentAndType(businessId: string | null, agentId: string | null, flagType: GovernanceFlagType): Promise<GovernanceFlagRecord | null> {
    const { rows } = await this.db.query<GovernanceFlagRow>(
      `SELECT * FROM governance_flags
       WHERE status = 'open' AND flag_type = $3
         AND business_id IS NOT DISTINCT FROM $1
         AND agent_id IS NOT DISTINCT FROM $2
       LIMIT 1`,
      [businessId, agentId, flagType],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
