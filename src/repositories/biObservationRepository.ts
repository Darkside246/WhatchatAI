import type { Queryable } from './types.js';

export type BiSourceType = 'chat' | 'invoice' | 'document' | 'review';
export type BiSentiment = 'positive' | 'neutral' | 'negative' | 'mixed' | 'unclear';
export type BiUrgency = 'low' | 'medium' | 'high';

export interface BiObservationRecord {
  id: string;
  businessId: string;
  sourceType: BiSourceType;
  periodStart: string;
  periodEnd: string;
  product: string | null;
  category: string | null;
  topic: string | null;
  subtopic: string | null;
  sentiment: BiSentiment | null;
  sentimentConfidence: number | null;
  intent: string | null;
  intentConfidence: number | null;
  feedbackType: string | null;
  complaintCategory: string | null;
  purchaseSignal: string | null;
  urgency: BiUrgency | null;
  evidenceCount: number;
  conversationCount: number;
  extractionConfidence: number | null;
  createdAt: string;
}

interface BiObservationRow {
  id: string;
  business_id: string;
  source_type: BiSourceType;
  period_start: string;
  period_end: string;
  product: string | null;
  category: string | null;
  topic: string | null;
  subtopic: string | null;
  sentiment: BiSentiment | null;
  sentiment_confidence: number | null;
  intent: string | null;
  intent_confidence: number | null;
  feedback_type: string | null;
  complaint_category: string | null;
  purchase_signal: string | null;
  urgency: BiUrgency | null;
  evidence_count: number;
  conversation_count: number;
  extraction_confidence: number | null;
  created_at: string;
}

function toRecord(row: BiObservationRow): BiObservationRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    sourceType: row.source_type,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    product: row.product,
    category: row.category,
    topic: row.topic,
    subtopic: row.subtopic,
    sentiment: row.sentiment,
    sentimentConfidence: row.sentiment_confidence,
    intent: row.intent,
    intentConfidence: row.intent_confidence,
    feedbackType: row.feedback_type,
    complaintCategory: row.complaint_category,
    purchaseSignal: row.purchase_signal,
    urgency: row.urgency,
    evidenceCount: row.evidence_count,
    conversationCount: row.conversation_count,
    extractionConfidence: row.extraction_confidence,
    createdAt: row.created_at,
  };
}

export interface CreateBiObservationInput {
  businessId: string;
  sourceType: BiSourceType;
  periodStart: string;
  periodEnd: string;
  product?: string | null;
  category?: string | null;
  topic?: string | null;
  subtopic?: string | null;
  sentiment?: BiSentiment | null;
  sentimentConfidence?: number | null;
  intent?: string | null;
  intentConfidence?: number | null;
  feedbackType?: string | null;
  complaintCategory?: string | null;
  purchaseSignal?: string | null;
  urgency?: BiUrgency | null;
  evidenceCount?: number;
  conversationCount?: number;
  extractionConfidence?: number | null;
}

/**
 * Business Intelligence Agent: the structured extraction unit - never
 * raw source text, only classification + real counts (data minimization
 * by construction). RLS'd (migration 996) - always construct with
 * queryAsTenant(businessId).
 */
export class BiObservationRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateBiObservationInput): Promise<BiObservationRecord> {
    const { rows } = await this.db.query<BiObservationRow>(
      `INSERT INTO bi_observations
         (business_id, source_type, period_start, period_end, product, category, topic, subtopic,
          sentiment, sentiment_confidence, intent, intent_confidence, feedback_type, complaint_category,
          purchase_signal, urgency, evidence_count, conversation_count, extraction_confidence)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       RETURNING *`,
      [
        input.businessId, input.sourceType, input.periodStart, input.periodEnd,
        input.product ?? null, input.category ?? null, input.topic ?? null, input.subtopic ?? null,
        input.sentiment ?? null, input.sentimentConfidence ?? null, input.intent ?? null, input.intentConfidence ?? null,
        input.feedbackType ?? null, input.complaintCategory ?? null, input.purchaseSignal ?? null, input.urgency ?? null,
        input.evidenceCount ?? 0, input.conversationCount ?? 0, input.extractionConfidence ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('bi_observations insert returned no row');
    return toRecord(row);
  }

  async listForPeriod(businessId: string, periodStart: string, periodEnd: string): Promise<BiObservationRecord[]> {
    const { rows } = await this.db.query<BiObservationRow>(
      `SELECT * FROM bi_observations WHERE business_id = $1 AND period_start >= $2 AND period_end <= $3 ORDER BY created_at DESC`,
      [businessId, periodStart, periodEnd],
    );
    return rows.map(toRecord);
  }

  /** Real, deterministic aggregation - grouped by product+topic+sentiment, with real sums, never estimated. Used by biTrendService.ts's own period-over-period comparison. */
  async aggregateByProductTopic(businessId: string, periodStart: string, periodEnd: string): Promise<{ product: string | null; topic: string | null; sentiment: BiSentiment | null; observationCount: number; conversationCount: number }[]> {
    const { rows } = await this.db.query<{ product: string | null; topic: string | null; sentiment: BiSentiment | null; observation_count: string; conversation_count: string }>(
      `SELECT product, topic, sentiment, count(*)::text AS observation_count, COALESCE(sum(conversation_count), 0)::text AS conversation_count
       FROM bi_observations
       WHERE business_id = $1 AND period_start >= $2 AND period_end <= $3
       GROUP BY product, topic, sentiment`,
      [businessId, periodStart, periodEnd],
    );
    return rows.map((row) => ({
      product: row.product,
      topic: row.topic,
      sentiment: row.sentiment,
      observationCount: Number(row.observation_count),
      conversationCount: Number(row.conversation_count),
    }));
  }
}
