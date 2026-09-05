import type { Queryable } from './types.js';

export type BiInsightCategory = 'sentiment' | 'product_performance' | 'feedback' | 'emerging' | 'operations';
export type BiInsightDirection = 'increasing' | 'decreasing' | 'stable' | 'emerging' | 'declining' | 'anomalous';
export type BiInsightConfidence = 'insufficient_data' | 'early_signal' | 'moderate' | 'high';
export type BiInsightStatus = 'processing' | 'approved' | 'rejected' | 'held';

export interface BiInsightRecord {
  id: string;
  businessId: string;
  category: BiInsightCategory;
  title: string;
  body: string;
  direction: BiInsightDirection | null;
  metricChangePct: number | null;
  periodStart: string;
  periodEnd: string;
  evidenceObservationCount: number;
  evidenceConversationCount: number;
  confidence: BiInsightConfidence;
  status: BiInsightStatus;
  qualityFlags: string[];
  createdAt: string;
  approvedAt: string | null;
}

interface BiInsightRow {
  id: string;
  business_id: string;
  category: BiInsightCategory;
  title: string;
  body: string;
  direction: BiInsightDirection | null;
  metric_change_pct: number | null;
  period_start: string;
  period_end: string;
  evidence_observation_count: number;
  evidence_conversation_count: number;
  confidence: BiInsightConfidence;
  status: BiInsightStatus;
  quality_flags: string[];
  created_at: string;
  approved_at: string | null;
}

function toRecord(row: BiInsightRow): BiInsightRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    category: row.category,
    title: row.title,
    body: row.body,
    direction: row.direction,
    metricChangePct: row.metric_change_pct,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    evidenceObservationCount: row.evidence_observation_count,
    evidenceConversationCount: row.evidence_conversation_count,
    confidence: row.confidence,
    status: row.status,
    qualityFlags: row.quality_flags ?? [],
    createdAt: row.created_at,
    approvedAt: row.approved_at,
  };
}

export interface CreateBiInsightInput {
  businessId: string;
  category: BiInsightCategory;
  title: string;
  body: string;
  direction?: BiInsightDirection | null;
  metricChangePct?: number | null;
  periodStart: string;
  periodEnd: string;
  evidenceObservationCount: number;
  evidenceConversationCount: number;
  confidence: BiInsightConfidence;
  status: BiInsightStatus;
  qualityFlags: string[];
}

/**
 * Business Intelligence Agent: the Trends-facing, end-of-line-approved
 * output. Only status='approved' rows are ever surfaced by the Trends
 * API - held/rejected stay internal, auditable via qualityFlags. RLS'd
 * (migration 996) - always construct with queryAsTenant(businessId).
 */
export class BiInsightRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateBiInsightInput): Promise<BiInsightRecord> {
    const { rows } = await this.db.query<BiInsightRow>(
      `INSERT INTO bi_insights
         (business_id, category, title, body, direction, metric_change_pct, period_start, period_end,
          evidence_observation_count, evidence_conversation_count, confidence, status, quality_flags,
          approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, CASE WHEN $12 = 'approved' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        input.businessId, input.category, input.title, input.body, input.direction ?? null, input.metricChangePct ?? null,
        input.periodStart, input.periodEnd, input.evidenceObservationCount, input.evidenceConversationCount,
        input.confidence, input.status, JSON.stringify(input.qualityFlags),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('bi_insights insert returned no row');
    return toRecord(row);
  }

  /** The Trends API's own read path - approved only, grouped by category by the caller. */
  async listApproved(businessId: string, limit = 100): Promise<BiInsightRecord[]> {
    const { rows } = await this.db.query<BiInsightRow>(
      `SELECT * FROM bi_insights WHERE business_id = $1 AND status = 'approved' ORDER BY period_end DESC, created_at DESC LIMIT $2`,
      [businessId, limit],
    );
    return rows.map(toRecord);
  }
}
