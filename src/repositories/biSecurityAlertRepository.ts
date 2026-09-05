import type { Queryable } from './types.js';

export type BiAlertType = 'pii_detected' | 'secret_detected' | 'prompt_injection_detected';
export type BiAlertSourceType = 'chat' | 'invoice' | 'document' | 'review' | 'generated_insight';

export interface BiSecurityAlertRecord {
  id: string;
  businessId: string;
  alertType: BiAlertType;
  sourceType: BiAlertSourceType;
  sourceId: string | null;
  redacted: boolean;
  createdAt: string;
}

interface BiSecurityAlertRow {
  id: string;
  business_id: string;
  alert_type: BiAlertType;
  source_type: BiAlertSourceType;
  source_id: string | null;
  redacted: boolean;
  created_at: string;
}

function toRecord(row: BiSecurityAlertRow): BiSecurityAlertRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    alertType: row.alert_type,
    sourceType: row.source_type,
    sourceId: row.source_id,
    redacted: row.redacted,
    createdAt: row.created_at,
  };
}

/**
 * Business Intelligence Agent - directive section 26. Never the actual
 * sensitive value, only the fact that something was found and redacted.
 * RLS'd (migration 996) - always construct with queryAsTenant(businessId).
 */
export class BiSecurityAlertRepository {
  constructor(private readonly db: Queryable) {}

  async record(input: { businessId: string; alertType: BiAlertType; sourceType: BiAlertSourceType; sourceId?: string | null; redacted?: boolean }): Promise<BiSecurityAlertRecord> {
    const { rows } = await this.db.query<BiSecurityAlertRow>(
      `INSERT INTO bi_security_alerts (business_id, alert_type, source_type, source_id, redacted)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [input.businessId, input.alertType, input.sourceType, input.sourceId ?? null, input.redacted ?? true],
    );
    const row = rows[0];
    if (!row) throw new Error('bi_security_alerts insert returned no row');
    return toRecord(row);
  }

  async listRecent(businessId: string, limit = 50): Promise<BiSecurityAlertRecord[]> {
    const { rows } = await this.db.query<BiSecurityAlertRow>(
      `SELECT * FROM bi_security_alerts WHERE business_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [businessId, limit],
    );
    return rows.map(toRecord);
  }
}
