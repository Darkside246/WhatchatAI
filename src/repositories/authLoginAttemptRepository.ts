import type { Queryable } from './types.js';

export class AuthLoginAttemptRepository {
  constructor(private readonly db: Queryable) {}

  async record(email: string, ipAddress: string | null, success: boolean): Promise<void> {
    await this.db.query('INSERT INTO auth_login_attempts (email, ip_address, success) VALUES ($1, $2, $3)', [
      email,
      ipAddress,
      success,
    ]);
  }

  async countRecentFailures(email: string, windowMinutes: number): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM auth_login_attempts
       WHERE email = $1 AND success = false AND created_at > now() - ($2 || ' minutes')::interval`,
      [email, String(windowMinutes)],
    );
    return Number(rows[0]?.count ?? '0');
  }
}
