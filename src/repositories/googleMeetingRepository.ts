import { getEncryptionService } from '../security/encryption/index.js';
import type { Queryable } from './types.js';

export type GoogleMeetingConnectionRecord = {
  id: string;
  businessId: string;
  googleEmail: string;
  displayName: string | null;
  tokenExpiresAt: string | null;
  scopes: string | null;
  connectedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
};

async function encryptToken(businessId: string, token: string): Promise<string> {
  const service = getEncryptionService();
  return service.serialize(await service.encryptField(businessId, token));
}

async function decryptToken(businessId: string, stored: string): Promise<string> {
  const service = getEncryptionService();
  const envelope = service.tryParse(stored);
  if (!envelope) return stored;
  return service.decryptField(businessId, envelope);
}

/**
 * One connection per business (see google_meeting_connections's unique
 * index on business_id) - unlike email_oauth_accounts, there is no
 * provider column to key on here since Zoom has its own table
 * (zoomMeetingRepository.ts / zoom_meeting_connections) rather than a
 * shared polymorphic one. Owns Google connection CRUD only - the shared
 * scheduled_meetings table (both providers' real booking history) lives in
 * scheduledMeetingsRepository.ts.
 */
export class GoogleMeetingRepository {
  constructor(private readonly db: Queryable) {}

  async upsertConnection(input: {
    businessId: string;
    googleEmail: string;
    displayName?: string | null;
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string | null;
    connectedByUserId?: string | null;
  }): Promise<GoogleMeetingConnectionRecord> {
    const accessTokenEnc = await encryptToken(input.businessId, input.accessToken);
    const refreshTokenEnc = input.refreshToken ? await encryptToken(input.businessId, input.refreshToken) : null;

    const result = await this.db.query(
      `INSERT INTO google_meeting_connections
         (business_id, google_email, display_name, access_token_enc, refresh_token_enc, token_expires_at, scopes, connected_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (business_id) DO UPDATE SET
         google_email       = EXCLUDED.google_email,
         display_name       = EXCLUDED.display_name,
         access_token_enc   = EXCLUDED.access_token_enc,
         refresh_token_enc  = COALESCE(EXCLUDED.refresh_token_enc, google_meeting_connections.refresh_token_enc),
         token_expires_at   = EXCLUDED.token_expires_at,
         scopes             = EXCLUDED.scopes,
         connected_by_user_id = EXCLUDED.connected_by_user_id,
         updated_at         = now()
       RETURNING *`,
      [
        input.businessId,
        input.googleEmail,
        input.displayName ?? null,
        accessTokenEnc,
        refreshTokenEnc,
        input.tokenExpiresAt?.toISOString() ?? null,
        input.scopes ?? null,
        input.connectedByUserId ?? null,
      ],
    );
    return this.mapConnection(result.rows[0] as Record<string, unknown>);
  }

  async updateTokens(connectionId: string, businessId: string, input: {
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
  }): Promise<void> {
    const accessTokenEnc = await encryptToken(businessId, input.accessToken);
    const refreshTokenEnc = input.refreshToken ? await encryptToken(businessId, input.refreshToken) : null;

    await this.db.query(
      `UPDATE google_meeting_connections SET
         access_token_enc  = $1,
         refresh_token_enc = COALESCE($2, refresh_token_enc),
         token_expires_at  = $3,
         updated_at        = now()
       WHERE id = $4`,
      [accessTokenEnc, refreshTokenEnc, input.tokenExpiresAt?.toISOString() ?? null, connectionId],
    );
  }

  async getConnectionByBusiness(businessId: string): Promise<GoogleMeetingConnectionRecord | null> {
    const result = await this.db.query(
      `SELECT id, business_id, google_email, display_name, token_expires_at, scopes, connected_by_user_id, created_at, updated_at
       FROM google_meeting_connections WHERE business_id = $1`,
      [businessId],
    );
    return result.rows[0] ? this.mapConnection(result.rows[0] as Record<string, unknown>) : null;
  }

  /** Returns decrypted tokens — only call from the service layer, never expose in an HTTP response. */
  async getTokens(connectionId: string, businessId: string): Promise<{ accessToken: string; refreshToken: string | null } | null> {
    const result = await this.db.query(
      `SELECT access_token_enc, refresh_token_enc FROM google_meeting_connections WHERE id = $1`,
      [connectionId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      accessToken: await decryptToken(businessId, row['access_token_enc'] as string),
      refreshToken: row['refresh_token_enc'] ? await decryptToken(businessId, row['refresh_token_enc'] as string) : null,
    };
  }

  async deleteConnection(businessId: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM google_meeting_connections WHERE business_id = $1`, [businessId]);
    return (result.rowCount ?? 0) > 0;
  }

  // Timestamp columns come back as plain ISO strings, not Date objects - the
  // pool's global TIMESTAMPTZ type parser (src/db/pool.ts) already converts
  // them - same convention as emailOAuthRepository.ts's own mapAccount().
  private mapConnection(row: Record<string, unknown>): GoogleMeetingConnectionRecord {
    return {
      id: row['id'] as string,
      businessId: row['business_id'] as string,
      googleEmail: row['google_email'] as string,
      displayName: row['display_name'] as string | null,
      tokenExpiresAt: row['token_expires_at'] as string | null,
      scopes: row['scopes'] as string | null,
      connectedByUserId: row['connected_by_user_id'] as string | null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }
}
