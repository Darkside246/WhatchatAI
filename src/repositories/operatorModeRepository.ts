import type { Queryable } from './types.js';

export type OperatorSettingsRecord = {
  id: string;
  businessId: string;
  operatorWaJid: string;
  enabled: boolean;
  pinSalt: string;
  pinHash: string;
  pinN: number;
  pinR: number;
  pinP: number;
  createdAt: string;
  updatedAt: string;
};

export type OperatorSessionRecord = {
  id: string;
  businessId: string;
  waJid: string;
  status: 'AWAITING_PIN' | 'AUTHENTICATED';
  pinAttempts: number;
  expiresAt: string;
  lastCommandAt: string | null;
  createdAt: string;
};

const SETTINGS_COLS = `
  id, business_id AS "businessId", operator_wa_jid AS "operatorWaJid", enabled,
  pin_salt AS "pinSalt", pin_hash AS "pinHash",
  pin_n AS "pinN", pin_r AS "pinR", pin_p AS "pinP",
  created_at AS "createdAt", updated_at AS "updatedAt"
`.trim();

const SESSION_COLS = `
  id, business_id AS "businessId", wa_jid AS "waJid", status,
  pin_attempts AS "pinAttempts", expires_at AS "expiresAt",
  last_command_at AS "lastCommandAt", created_at AS "createdAt"
`.trim();

export class OperatorModeRepository {
  constructor(private readonly db: Queryable) {}

  // ── Settings ────────────────────────────────────────────────────────────────

  async getSettings(businessId: string): Promise<OperatorSettingsRecord | null> {
    const { rows } = await this.db.query<OperatorSettingsRecord>(
      `SELECT ${SETTINGS_COLS} FROM operator_settings WHERE business_id = $1`,
      [businessId],
    );
    return rows[0] ?? null;
  }

  async upsertSettings(input: {
    businessId: string;
    operatorWaJid: string;
    pinSalt: string;
    pinHash: string;
    pinN: number;
    pinR: number;
    pinP: number;
    enabled?: boolean;
  }): Promise<OperatorSettingsRecord> {
    const { rows } = await this.db.query<OperatorSettingsRecord>(
      `INSERT INTO operator_settings
         (business_id, operator_wa_jid, pin_salt, pin_hash, pin_n, pin_r, pin_p, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (business_id) DO UPDATE SET
         operator_wa_jid = EXCLUDED.operator_wa_jid,
         pin_salt = EXCLUDED.pin_salt,
         pin_hash = EXCLUDED.pin_hash,
         pin_n = EXCLUDED.pin_n,
         pin_r = EXCLUDED.pin_r,
         pin_p = EXCLUDED.pin_p,
         enabled = COALESCE(EXCLUDED.enabled, operator_settings.enabled),
         updated_at = NOW()
       RETURNING ${SETTINGS_COLS}`,
      [
        input.businessId, input.operatorWaJid,
        input.pinSalt, input.pinHash, input.pinN, input.pinR, input.pinP,
        input.enabled ?? true,
      ],
    );
    if (!rows[0]) throw new Error('operator settings upsert returned no row');
    return rows[0];
  }

  async setEnabled(businessId: string, enabled: boolean): Promise<void> {
    await this.db.query(
      `UPDATE operator_settings SET enabled = $2, updated_at = NOW() WHERE business_id = $1`,
      [businessId, enabled],
    );
  }

  // ── Sessions ─────────────────────────────────────────────────────────────────

  async getActiveSession(businessId: string): Promise<OperatorSessionRecord | null> {
    const { rows } = await this.db.query<OperatorSessionRecord>(
      `SELECT ${SESSION_COLS} FROM operator_sessions WHERE business_id = $1 AND expires_at > NOW()`,
      [businessId],
    );
    return rows[0] ?? null;
  }

  async createChallengeSession(businessId: string, waJid: string): Promise<OperatorSessionRecord> {
    await this.db.query(`DELETE FROM operator_sessions WHERE business_id = $1`, [businessId]);
    const { rows } = await this.db.query<OperatorSessionRecord>(
      `INSERT INTO operator_sessions (business_id, wa_jid, status, expires_at)
       VALUES ($1, $2, 'AWAITING_PIN', NOW() + INTERVAL '2 minutes')
       RETURNING ${SESSION_COLS}`,
      [businessId, waJid],
    );
    if (!rows[0]) throw new Error('session insert returned no row');
    return rows[0];
  }

  async authenticateSession(businessId: string): Promise<OperatorSessionRecord | null> {
    const { rows } = await this.db.query<OperatorSessionRecord>(
      `UPDATE operator_sessions
       SET status = 'AUTHENTICATED', expires_at = NOW() + INTERVAL '30 minutes'
       WHERE business_id = $1 AND status = 'AWAITING_PIN' AND expires_at > NOW()
       RETURNING ${SESSION_COLS}`,
      [businessId],
    );
    return rows[0] ?? null;
  }

  async bumpSession(businessId: string): Promise<void> {
    await this.db.query(
      `UPDATE operator_sessions
       SET expires_at = NOW() + INTERVAL '30 minutes', last_command_at = NOW()
       WHERE business_id = $1 AND status = 'AUTHENTICATED'`,
      [businessId],
    );
  }

  async incrementPinAttempts(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ pinAttempts: number }>(
      `UPDATE operator_sessions SET pin_attempts = pin_attempts + 1
       WHERE business_id = $1
       RETURNING pin_attempts AS "pinAttempts"`,
      [businessId],
    );
    return rows[0]?.pinAttempts ?? 0;
  }

  async deleteSession(businessId: string): Promise<void> {
    await this.db.query(`DELETE FROM operator_sessions WHERE business_id = $1`, [businessId]);
  }
}
