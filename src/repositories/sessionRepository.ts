import type { Queryable } from './types.js';

export interface SessionRecord {
  id: string;
  userId: string;
  businessId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  deviceName: string | null;
  authMethod: string;
}

interface SessionRow {
  id: string;
  user_id: string;
  business_id: string;
  token_hash: string;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  ip_address: string | null;
  user_agent: string | null;
  device_name: string | null;
  auth_method: string;
}

function toRecord(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    businessId: row.business_id,
    tokenHash: row.token_hash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    deviceName: row.device_name,
    authMethod: row.auth_method,
  };
}

export interface CreateSessionInput {
  userId: string;
  businessId: string;
  tokenHash: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  deviceName: string | null;
  authMethod: string;
}

export class SessionRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const { rows } = await this.db.query<SessionRow>(
      `INSERT INTO sessions (user_id, business_id, token_hash, expires_at, ip_address, user_agent, device_name, auth_method)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [input.userId, input.businessId, input.tokenHash, input.expiresAt, input.ipAddress, input.userAgent, input.deviceName, input.authMethod],
    );
    const row = rows[0];
    if (!row) throw new Error('sessions insert returned no row');
    return toRecord(row);
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const { rows } = await this.db.query<SessionRow>('SELECT * FROM sessions WHERE token_hash = $1', [tokenHash]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<SessionRecord | null> {
    const { rows } = await this.db.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listActiveForUser(userId: string): Promise<SessionRecord[]> {
    const { rows } = await this.db.query<SessionRow>(
      `SELECT * FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`,
      [userId],
    );
    return rows.map(toRecord);
  }

  /** Throttled by the caller (authService) to avoid a write on every single request. */
  async touchLastSeen(id: string): Promise<void> {
    await this.db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [id]);
  }

  async revoke(id: string): Promise<void> {
    await this.db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
  }

  async revokeAllForUserExcept(userId: string, exceptSessionId: string | null): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id != $2)`,
      [userId, exceptSessionId],
    );
    return rowCount ?? 0;
  }

  /**
   * Revokes this user's other active sessions that match the exact same
   * (ipAddress, userAgent) pair as the session just created - a real
   * re-login from the same browser/device, not a genuinely new one. Never
   * touches sessions from a different IP or user agent (a teammate, or the
   * same user on a different device/location), so multi-location use stays
   * intact. Exact-match only, never IS NOT DISTINCT FROM null-matching -
   * two sessions with an unknown IP or user agent are never treated as the
   * same device on that basis alone.
   */
  async revokeMatchingDeviceForUser(
    userId: string,
    ipAddress: string,
    userAgent: string,
    exceptSessionId: string,
  ): Promise<number> {
    const { rowCount } = await this.db.query(
      `UPDATE sessions SET revoked_at = now()
       WHERE user_id = $1 AND revoked_at IS NULL AND id != $2
         AND ip_address = $3 AND user_agent = $4`,
      [userId, exceptSessionId, ipAddress, userAgent],
    );
    return rowCount ?? 0;
  }
}
