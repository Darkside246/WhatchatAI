import { getEncryptionService } from '../security/encryption/index.js';
import type { Queryable } from './types.js';

export type ZoomMeetingConnectionRecord = {
  id: string;
  businessId: string;
  zoomEmail: string;
  zoomUserId: string;
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
 * One connection per business (see zoom_meeting_connections's unique index
 * on business_id) - mirrors googleMeetingRepository.ts's shape exactly.
 * Owns Zoom connection CRUD only - the shared scheduled_meetings table
 * (both providers' real booking history) lives in
 * scheduledMeetingsRepository.ts.
 */
export class ZoomMeetingRepository {
  constructor(private readonly db: Queryable) {}

  async upsertConnection(input: {
    businessId: string;
    zoomEmail: string;
    zoomUserId: string;
    displayName?: string | null;
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string | null;
    connectedByUserId?: string | null;
  }): Promise<ZoomMeetingConnectionRecord> {
    const accessTokenEnc = await encryptToken(input.businessId, input.accessToken);
    const refreshTokenEnc = input.refreshToken ? await encryptToken(input.businessId, input.refreshToken) : null;

    const result = await this.db.query(
      `INSERT INTO zoom_meeting_connections
         (business_id, zoom_email, zoom_user_id, display_name, access_token_enc, refresh_token_enc, token_expires_at, scopes, connected_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (business_id) DO UPDATE SET
         zoom_email         = EXCLUDED.zoom_email,
         zoom_user_id       = EXCLUDED.zoom_user_id,
         display_name       = EXCLUDED.display_name,
         access_token_enc   = EXCLUDED.access_token_enc,
         refresh_token_enc  = COALESCE(EXCLUDED.refresh_token_enc, zoom_meeting_connections.refresh_token_enc),
         token_expires_at   = EXCLUDED.token_expires_at,
         scopes             = EXCLUDED.scopes,
         connected_by_user_id = EXCLUDED.connected_by_user_id,
         updated_at         = now()
       RETURNING *`,
      [
        input.businessId,
        input.zoomEmail,
        input.zoomUserId,
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
      `UPDATE zoom_meeting_connections SET
         access_token_enc  = $1,
         refresh_token_enc = COALESCE($2, refresh_token_enc),
         token_expires_at  = $3,
         updated_at        = now()
       WHERE id = $4`,
      [accessTokenEnc, refreshTokenEnc, input.tokenExpiresAt?.toISOString() ?? null, connectionId],
    );
  }

  async getConnectionByBusiness(businessId: string): Promise<ZoomMeetingConnectionRecord | null> {
    const result = await this.db.query(
      `SELECT id, business_id, zoom_email, zoom_user_id, display_name, token_expires_at, scopes, connected_by_user_id, created_at, updated_at
       FROM zoom_meeting_connections WHERE business_id = $1`,
      [businessId],
    );
    return result.rows[0] ? this.mapConnection(result.rows[0] as Record<string, unknown>) : null;
  }

  /** Returns decrypted tokens — only call from the service layer, never expose in an HTTP response. */
  async getTokens(connectionId: string, businessId: string): Promise<{ accessToken: string; refreshToken: string | null } | null> {
    const result = await this.db.query(
      `SELECT access_token_enc, refresh_token_enc FROM zoom_meeting_connections WHERE id = $1`,
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
    const result = await this.db.query(`DELETE FROM zoom_meeting_connections WHERE business_id = $1`, [businessId]);
    return (result.rowCount ?? 0) > 0;
  }

  // Timestamp columns come back as plain ISO strings, not Date objects - the
  // pool's global TIMESTAMPTZ type parser (src/db/pool.ts) already converts
  // them - same convention as googleMeetingRepository.ts's own mapConnection().
  private mapConnection(row: Record<string, unknown>): ZoomMeetingConnectionRecord {
    return {
      id: row['id'] as string,
      businessId: row['business_id'] as string,
      zoomEmail: row['zoom_email'] as string,
      zoomUserId: row['zoom_user_id'] as string,
      displayName: row['display_name'] as string | null,
      tokenExpiresAt: row['token_expires_at'] as string | null,
      scopes: row['scopes'] as string | null,
      connectedByUserId: row['connected_by_user_id'] as string | null,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }
}
