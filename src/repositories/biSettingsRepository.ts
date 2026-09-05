import type { Queryable } from './types.js';

export interface BiSettingsRecord {
  businessId: string;
  enabled: boolean;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface BiSettingsRow {
  business_id: string;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: BiSettingsRow): BiSettingsRecord {
  return {
    businessId: row.business_id,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Business Intelligence Agent: per-business opt-in, same fail-closed-by-
 * default shape as writing_twin_settings - nothing is analyzed until a
 * business owner explicitly enables this. RLS'd (migration 996) - always
 * construct with queryAsTenant(businessId), never the bare pool.
 */
export class BiSettingsRepository {
  constructor(private readonly db: Queryable) {}

  async get(businessId: string): Promise<BiSettingsRecord | null> {
    const { rows } = await this.db.query<BiSettingsRow>(`SELECT * FROM bi_settings WHERE business_id = $1`, [businessId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async setEnabled(businessId: string, enabled: boolean): Promise<BiSettingsRecord> {
    const { rows } = await this.db.query<BiSettingsRow>(
      `INSERT INTO bi_settings (business_id, enabled) VALUES ($1, $2)
       ON CONFLICT (business_id) DO UPDATE SET enabled = $2, updated_at = now()
       RETURNING *`,
      [businessId, enabled],
    );
    const row = rows[0];
    if (!row) throw new Error('bi_settings upsert returned no row');
    return toRecord(row);
  }

  async recordRun(businessId: string): Promise<void> {
    await this.db.query(`UPDATE bi_settings SET last_run_at = now(), updated_at = now() WHERE business_id = $1`, [businessId]);
  }

  /** The one deliberately tenant-agnostic listing - the scheduled sweep genuinely needs every enabled business at once, same reasoning as every other real platform-wide sweep in this codebase. */
  async listAllEnabled(): Promise<BiSettingsRecord[]> {
    const { rows } = await this.db.query<BiSettingsRow>(`SELECT * FROM bi_settings WHERE enabled = true`);
    return rows.map(toRecord);
  }
}
