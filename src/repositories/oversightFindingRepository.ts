import type { Queryable } from './types.js';
import { withTransaction } from '../db/transaction.js';

export type OversightCategory = 'application_health' | 'security' | 'abuse_spam' | 'capacity' | 'policy' | 'monitoring_gap';
export type OversightSeverity = 'critical' | 'high' | 'medium' | 'low' | 'informational';
export type OversightStatus = 'detected' | 'investigating' | 'awaiting_human_review' | 'approved' | 'rejected' | 'resolved' | 'monitoring';

export interface OversightFindingRecord {
  id: string;
  category: OversightCategory;
  findingType: string;
  title: string;
  severity: OversightSeverity;
  confidence: number | null;
  impact: number | null;
  likelihood: number | null;
  exposure: number | null;
  urgency: number | null;
  scopeDescription: string | null;
  compositeRiskScore: number | null;
  businessId: string | null;
  affectedComponent: string | null;
  evidence: Record<string, unknown>;
  potentialCauses: string[] | null;
  rootCause: string | null;
  recommendedInvestigation: string | null;
  recommendedRemediation: string | null;
  status: OversightStatus;
  reviewedByUserId: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  dedupKey: string;
  firstDetectedAt: string;
  lastDetectedAt: string;
  occurrenceCount: number;
  createdAt: string;
  /** Only populated by listOpenAcrossPlatform's server-side join - null everywhere else. */
  businessName?: string | null;
}

interface OversightFindingRow {
  id: string;
  category: OversightCategory;
  finding_type: string;
  title: string;
  severity: OversightSeverity;
  confidence: number | null;
  impact: number | null;
  likelihood: number | null;
  exposure: number | null;
  urgency: number | null;
  scope_description: string | null;
  composite_risk_score: number | null;
  business_id: string | null;
  affected_component: string | null;
  evidence: Record<string, unknown>;
  potential_causes: string[] | null;
  root_cause: string | null;
  recommended_investigation: string | null;
  recommended_remediation: string | null;
  status: OversightStatus;
  reviewed_by_user_id: string | null;
  window_start: string | null;
  window_end: string | null;
  dedup_key: string;
  first_detected_at: string;
  last_detected_at: string;
  occurrence_count: number;
  created_at: string;
  business_name?: string | null;
}

function toRecord(row: OversightFindingRow): OversightFindingRecord {
  return {
    id: row.id,
    category: row.category,
    findingType: row.finding_type,
    title: row.title,
    severity: row.severity,
    confidence: row.confidence,
    impact: row.impact,
    likelihood: row.likelihood,
    exposure: row.exposure,
    urgency: row.urgency,
    scopeDescription: row.scope_description,
    compositeRiskScore: row.composite_risk_score,
    businessId: row.business_id,
    affectedComponent: row.affected_component,
    evidence: row.evidence ?? {},
    potentialCauses: row.potential_causes,
    rootCause: row.root_cause,
    recommendedInvestigation: row.recommended_investigation,
    recommendedRemediation: row.recommended_remediation,
    status: row.status,
    reviewedByUserId: row.reviewed_by_user_id,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    dedupKey: row.dedup_key,
    firstDetectedAt: row.first_detected_at,
    lastDetectedAt: row.last_detected_at,
    occurrenceCount: row.occurrence_count,
    createdAt: row.created_at,
    ...(row.business_name !== undefined ? { businessName: row.business_name } : {}),
  };
}

export interface CreateOversightFindingInput {
  category: OversightCategory;
  findingType: string;
  title: string;
  severity: OversightSeverity;
  confidence?: number | null;
  impact?: number | null;
  likelihood?: number | null;
  exposure?: number | null;
  urgency?: number | null;
  scopeDescription?: string | null;
  compositeRiskScore?: number | null;
  businessId?: string | null;
  affectedComponent?: string | null;
  evidence?: Record<string, unknown>;
  potentialCauses?: string[] | null;
  rootCause?: string | null;
  recommendedInvestigation?: string | null;
  recommendedRemediation?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
  dedupKey: string;
}

const TERMINAL_STATUSES: OversightStatus[] = ['resolved', 'rejected'];

/**
 * AURA AI Oversight & Reliability Agent: broader, additional supervisory
 * findings computed by oversightSweepService.ts, complementing (not
 * replacing) AI Governance v1's own narrower governance_flags. RLS'd
 * (migration 1005). listOpenAcrossPlatform is the one deliberate bare-pool
 * exception (the developer dashboard's cross-business view), mirroring
 * GovernanceFlagRepository's own precedent - every write in this file
 * goes through the bare pool since the sweep itself scans platform-wide,
 * exactly like Governance v1's real production wiring.
 */
export class OversightFindingRepository {
  constructor(private readonly db: Queryable) {}

  /** The sweep's own de-dup lookup - at most one non-terminal finding per dedup_key at a time. */
  async findOpenByDedupKey(dedupKey: string): Promise<OversightFindingRecord | null> {
    const { rows } = await this.db.query<OversightFindingRow>(
      `SELECT * FROM oversight_findings WHERE dedup_key = $1 AND status NOT IN ('resolved', 'rejected') LIMIT 1`,
      [dedupKey],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Creates a brand-new finding plus its 'raised' event row, atomically. */
  async create(input: CreateOversightFindingInput): Promise<OversightFindingRecord> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<OversightFindingRow>(
        `INSERT INTO oversight_findings
           (category, finding_type, title, severity, confidence, impact, likelihood, exposure, urgency,
            scope_description, composite_risk_score, business_id, affected_component, evidence, potential_causes,
            root_cause, recommended_investigation, recommended_remediation, window_start, window_end, dedup_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
         RETURNING *`,
        [
          input.category, input.findingType, input.title, input.severity,
          input.confidence ?? null, input.impact ?? null, input.likelihood ?? null, input.exposure ?? null, input.urgency ?? null,
          input.scopeDescription ?? null, input.compositeRiskScore ?? null, input.businessId ?? null, input.affectedComponent ?? null,
          JSON.stringify(input.evidence ?? {}), input.potentialCauses ? JSON.stringify(input.potentialCauses) : null,
          input.rootCause ?? null, input.recommendedInvestigation ?? null, input.recommendedRemediation ?? null,
          input.windowStart ?? null, input.windowEnd ?? null, input.dedupKey,
        ],
      );
      const row = rows[0];
      if (!row) throw new Error('oversight_findings insert returned no row');
      await client.query(
        `INSERT INTO oversight_finding_events (finding_id, event_type, to_status) VALUES ($1, 'raised', $2)`,
        [row.id, row.status],
      );
      return toRecord(row);
    });
  }

  /** Bumps an already-open finding's occurrence_count/last_detected_at rather than creating a new row - the "one continuing finding, not a new emergency every sweep" rule. Records a real 'reoccurred' event. */
  async recordReoccurrence(id: string): Promise<OversightFindingRecord> {
    return withTransaction(async (client) => {
      const { rows } = await client.query<OversightFindingRow>(
        `UPDATE oversight_findings SET occurrence_count = occurrence_count + 1, last_detected_at = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new Error(`oversight_findings row ${id} not found for reoccurrence`);
      await client.query(
        `INSERT INTO oversight_finding_events (finding_id, event_type) VALUES ($1, 'reoccurred')`,
        [id],
      );
      return toRecord(row);
    });
  }

  /** Bare-pool, the one deliberate tenant-agnostic method - the developer dashboard's own cross-business view. Joins businesses server-side so the frontend never needs a second name lookup. */
  async listOpenAcrossPlatform(filters?: { category?: OversightCategory; severity?: OversightSeverity }, limit = 200): Promise<OversightFindingRecord[]> {
    const conditions = [`status NOT IN ('resolved', 'rejected')`];
    const params: unknown[] = [];
    if (filters?.category) {
      params.push(filters.category);
      conditions.push(`category = $${params.length}`);
    }
    if (filters?.severity) {
      params.push(filters.severity);
      conditions.push(`severity = $${params.length}`);
    }
    params.push(limit);
    const { rows } = await this.db.query<OversightFindingRow>(
      `SELECT f.*, b.name AS business_name
       FROM oversight_findings f
       LEFT JOIN businesses b ON b.id = f.business_id
       WHERE ${conditions.join(' AND ')}
       ORDER BY f.severity = 'critical' DESC, f.severity = 'high' DESC, f.last_detected_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows.map(toRecord);
  }

  /**
   * Conditional status transition + a real 'status_changed' event row,
   * atomically. Returns null if the finding is already in a terminal
   * state (resolved/rejected) - never silently reopens or overwrites a
   * closed finding, same discipline as GovernanceFlagRepository's
   * markReviewed/markDismissed.
   */
  async changeStatus(id: string, toStatus: OversightStatus, userId: string, notes?: string | null): Promise<OversightFindingRecord | null> {
    return withTransaction(async (client) => {
      const current = await client.query<OversightFindingRow>(`SELECT * FROM oversight_findings WHERE id = $1`, [id]);
      const existing = current.rows[0];
      if (!existing || TERMINAL_STATUSES.includes(existing.status)) return null;

      const { rows } = await client.query<OversightFindingRow>(
        `UPDATE oversight_findings SET status = $2, reviewed_by_user_id = $3 WHERE id = $1 RETURNING *`,
        [id, toStatus, userId],
      );
      const row = rows[0];
      if (!row) return null;
      await client.query(
        `INSERT INTO oversight_finding_events (finding_id, event_type, from_status, to_status, user_id, notes) VALUES ($1, 'status_changed', $2, $3, $4, $5)`,
        [id, existing.status, toStatus, userId, notes ?? null],
      );
      return toRecord(row);
    });
  }

  async listEventsForFinding(findingId: string): Promise<Array<{ id: string; eventType: string; fromStatus: string | null; toStatus: string | null; userId: string | null; notes: string | null; createdAt: string }>> {
    const { rows } = await this.db.query<{ id: string; event_type: string; from_status: string | null; to_status: string | null; user_id: string | null; notes: string | null; created_at: string }>(
      `SELECT * FROM oversight_finding_events WHERE finding_id = $1 ORDER BY created_at ASC`,
      [findingId],
    );
    return rows.map((r) => ({ id: r.id, eventType: r.event_type, fromStatus: r.from_status, toStatus: r.to_status, userId: r.user_id, notes: r.notes, createdAt: r.created_at }));
  }

  async recordSample(metricKey: string, value: number, businessId: string | null = null): Promise<void> {
    await this.db.query(`INSERT INTO oversight_metric_samples (metric_key, business_id, value) VALUES ($1, $2, $3)`, [metricKey, businessId, value]);
  }

  async listRecentSamples(metricKey: string, sinceIso: string, businessId: string | null = null): Promise<Array<{ value: number; sampledAt: string }>> {
    const { rows } = await this.db.query<{ value: string; sampled_at: string }>(
      `SELECT value, sampled_at FROM oversight_metric_samples
       WHERE metric_key = $1 AND sampled_at >= $2 AND business_id IS NOT DISTINCT FROM $3
       ORDER BY sampled_at ASC`,
      [metricKey, sinceIso, businessId],
    );
    return rows.map((r) => ({ value: Number(r.value), sampledAt: r.sampled_at }));
  }
}
