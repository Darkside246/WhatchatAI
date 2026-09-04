import type { Queryable } from './types.js';

export interface PlatformSettingRecord {
  key: string;
  value: unknown;
  updatedAt: string;
  updatedByUserId: string | null;
}

interface PlatformSettingRow {
  key: string;
  value: unknown;
  updated_at: string;
  updated_by_user_id: string | null;
}

function toRecord(row: PlatformSettingRow): PlatformSettingRecord {
  return { key: row.key, value: row.value, updatedAt: row.updated_at, updatedByUserId: row.updated_by_user_id };
}

/**
 * A small, generic, developer-only key/value store for platform-wide
 * toggles that need to take effect live from the Control Plane, not just
 * via an env var + redeploy (see migration 977). Reused by both the
 * payment-provider enable/disable switches (Section 73-74) and the
 * autonomy kill switch (Section 41-42 Phase 1) - genuinely two real
 * callers, not a speculative abstraction.
 */
export class PlatformSettingsRepository {
  constructor(private readonly db: Queryable) {}

  async get(key: string): Promise<PlatformSettingRecord | null> {
    const { rows } = await this.db.query<PlatformSettingRow>('SELECT * FROM platform_settings WHERE key = $1', [key]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listAll(): Promise<PlatformSettingRecord[]> {
    const { rows } = await this.db.query<PlatformSettingRow>('SELECT * FROM platform_settings ORDER BY key');
    return rows.map(toRecord);
  }

  async set(key: string, value: unknown, updatedByUserId: string | null): Promise<PlatformSettingRecord> {
    const { rows } = await this.db.query<PlatformSettingRow>(
      `INSERT INTO platform_settings (key, value, updated_by_user_id)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_by_user_id = $3, updated_at = now()
       RETURNING *`,
      [key, JSON.stringify(value), updatedByUserId],
    );
    const row = rows[0];
    if (!row) throw new Error('platform_settings upsert returned no row');
    return toRecord(row);
  }
}
