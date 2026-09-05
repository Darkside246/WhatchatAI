import type { Queryable } from './types.js';

export type CustomerReviewSource = 'whatsapp_followup' | 'manual' | 'other';

export interface CustomerReviewRecord {
  id: string;
  businessId: string;
  crmContactId: string | null;
  source: CustomerReviewSource;
  rating: number | null;
  reviewText: string | null;
  collectedAt: string;
  createdAt: string;
}

interface CustomerReviewRow {
  id: string;
  business_id: string;
  crm_contact_id: string | null;
  source: CustomerReviewSource;
  rating: number | null;
  review_text: string | null;
  collected_at: string;
  created_at: string;
}

function toRecord(row: CustomerReviewRow): CustomerReviewRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    crmContactId: row.crm_contact_id,
    source: row.source,
    rating: row.rating,
    reviewText: row.review_text,
    collectedAt: row.collected_at,
    createdAt: row.created_at,
  };
}

/**
 * A new, currently-unpopulated Business Intelligence data source (see
 * migration 996's own comment): real schema now, so the BI pipeline
 * already reads from it, but the actual WhatsApp-follow-up collection
 * flow that would populate source='whatsapp_followup' rows is out of
 * scope for this build. `create()` exists so a manual/other-sourced
 * review can be entered today. RLS'd - always construct with
 * queryAsTenant(businessId).
 */
export class CustomerReviewRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { businessId: string; crmContactId?: string | null; source?: CustomerReviewSource; rating?: number | null; reviewText?: string | null }): Promise<CustomerReviewRecord> {
    const { rows } = await this.db.query<CustomerReviewRow>(
      `INSERT INTO customer_reviews (business_id, crm_contact_id, source, rating, review_text)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.businessId, input.crmContactId ?? null, input.source ?? 'manual', input.rating ?? null, input.reviewText ?? null],
    );
    const row = rows[0];
    if (!row) throw new Error('customer_reviews insert returned no row');
    return toRecord(row);
  }

  async listForBusinessSince(businessId: string, sinceIso: string, limit = 500): Promise<CustomerReviewRecord[]> {
    const { rows } = await this.db.query<CustomerReviewRow>(
      `SELECT * FROM customer_reviews WHERE business_id = $1 AND collected_at >= $2 ORDER BY collected_at DESC LIMIT $3`,
      [businessId, sinceIso, limit],
    );
    return rows.map(toRecord);
  }
}
