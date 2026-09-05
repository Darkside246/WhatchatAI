import type { Queryable } from './types.js';

export interface EmailAiSuggestionsRecord {
  id: string;
  businessId: string;
  generatedOn: string;
  suggestions: string[];
  createdAt: string;
}

interface EmailAiSuggestionsRow {
  id: string;
  business_id: string;
  generated_on: string;
  suggestions: string[];
  created_at: string;
}

function toRecord(row: EmailAiSuggestionsRow): EmailAiSuggestionsRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    generatedOn: row.generated_on,
    suggestions: row.suggestions,
    createdAt: row.created_at,
  };
}

/**
 * Email Redesign Phase D: the once-per-day cache backing the AI daily
 * suggestions card - one row per (business, calendar day), so the
 * digest is never regenerated on every page load. RLS'd (migration 992) -
 * always construct with queryAsTenant(businessId).
 */
export class EmailAiSuggestionsRepository {
  constructor(private readonly db: Queryable) {}

  /** Real UTC-day boundary, matching this codebase's own established convention for "once per calendar day/month" checks elsewhere. */
  async getForToday(businessId: string): Promise<EmailAiSuggestionsRecord | null> {
    const { rows } = await this.db.query<EmailAiSuggestionsRow>(
      `SELECT * FROM email_ai_suggestions WHERE business_id = $1 AND generated_on = (now() AT TIME ZONE 'UTC')::date`,
      [businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async upsertForToday(businessId: string, suggestions: string[]): Promise<EmailAiSuggestionsRecord> {
    const { rows } = await this.db.query<EmailAiSuggestionsRow>(
      `INSERT INTO email_ai_suggestions (business_id, generated_on, suggestions)
       VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2)
       ON CONFLICT (business_id, generated_on) DO UPDATE SET suggestions = EXCLUDED.suggestions
       RETURNING *`,
      [businessId, JSON.stringify(suggestions)],
    );
    const row = rows[0];
    if (!row) throw new Error('email_ai_suggestions upsert returned no row');
    return toRecord(row);
  }
}
