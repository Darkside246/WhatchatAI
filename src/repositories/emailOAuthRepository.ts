import { getEncryptionService } from '../security/encryption/index.js';
import type { Queryable } from './types.js';

export type OAuthProvider = 'gmail' | 'outlook';

export type EmailOAuthAccountRecord = {
  id: string;
  businessId: string;
  provider: OAuthProvider;
  emailAddress: string;
  displayName: string | null;
  tokenExpiresAt: string | null;
  scopes: string | null;
  syncCursor: string | null;
  lastSyncedAt: string | null;
  syncEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};

export type EmailOAuthMessageRecord = {
  id: string;
  accountId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  folder: string;
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  snippet: string | null;
  bodyHtml: string | null;
  bodyText: string | null;
  isRead: boolean;
  isStarred: boolean;
  labels: string[];
  receivedAt: string | null;
  syncedAt: string;
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

export class EmailOAuthRepository {
  constructor(private readonly db: Queryable) {}

  async upsertAccount(input: {
    businessId: string;
    provider: OAuthProvider;
    emailAddress: string;
    displayName?: string | null;
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
    scopes?: string | null;
  }): Promise<EmailOAuthAccountRecord> {
    const accessTokenEnc = await encryptToken(input.businessId, input.accessToken);
    const refreshTokenEnc = input.refreshToken
      ? await encryptToken(input.businessId, input.refreshToken)
      : null;

    const result = await this.db.query(
      `INSERT INTO email_oauth_accounts
         (business_id, provider, email_address, display_name, access_token_enc, refresh_token_enc, token_expires_at, scopes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (business_id, provider) DO UPDATE SET
         email_address     = EXCLUDED.email_address,
         display_name      = EXCLUDED.display_name,
         access_token_enc  = EXCLUDED.access_token_enc,
         refresh_token_enc = COALESCE(EXCLUDED.refresh_token_enc, email_oauth_accounts.refresh_token_enc),
         token_expires_at  = EXCLUDED.token_expires_at,
         scopes            = EXCLUDED.scopes,
         updated_at        = now()
       RETURNING *`,
      [
        input.businessId,
        input.provider,
        input.emailAddress,
        input.displayName ?? null,
        accessTokenEnc,
        refreshTokenEnc,
        input.tokenExpiresAt?.toISOString() ?? null,
        input.scopes ?? null,
      ],
    );
    return this.mapAccount(result.rows[0] as Record<string, unknown>);
  }

  async updateTokens(accountId: string, businessId: string, input: {
    accessToken: string;
    refreshToken?: string | null;
    tokenExpiresAt?: Date | null;
  }): Promise<void> {
    const accessTokenEnc = await encryptToken(businessId, input.accessToken);
    const refreshTokenEnc = input.refreshToken
      ? await encryptToken(businessId, input.refreshToken)
      : null;

    await this.db.query(
      `UPDATE email_oauth_accounts SET
         access_token_enc  = $1,
         refresh_token_enc = COALESCE($2, refresh_token_enc),
         token_expires_at  = $3,
         updated_at        = now()
       WHERE id = $4`,
      [accessTokenEnc, refreshTokenEnc, input.tokenExpiresAt?.toISOString() ?? null, accountId],
    );
  }

  async updateSyncCursor(accountId: string, cursor: string): Promise<void> {
    await this.db.query(
      `UPDATE email_oauth_accounts SET sync_cursor = $1, last_synced_at = now(), updated_at = now() WHERE id = $2`,
      [cursor, accountId],
    );
  }

  async listByBusiness(businessId: string): Promise<EmailOAuthAccountRecord[]> {
    const result = await this.db.query(
      `SELECT id, business_id, provider, email_address, display_name, token_expires_at,
              scopes, sync_cursor, last_synced_at, sync_enabled, created_at, updated_at
       FROM email_oauth_accounts WHERE business_id = $1 ORDER BY created_at`,
      [businessId],
    );
    return result.rows.map((r) => this.mapAccount(r as Record<string, unknown>));
  }

  async getById(accountId: string): Promise<EmailOAuthAccountRecord | null> {
    const result = await this.db.query(
      `SELECT id, business_id, provider, email_address, display_name, token_expires_at,
              scopes, sync_cursor, last_synced_at, sync_enabled, created_at, updated_at
       FROM email_oauth_accounts WHERE id = $1`,
      [accountId],
    );
    return result.rows[0] ? this.mapAccount(result.rows[0] as Record<string, unknown>) : null;
  }

  /** Returns decrypted tokens — only call from service layer, never expose in HTTP response. */
  async getTokens(accountId: string, businessId: string): Promise<{ accessToken: string; refreshToken: string | null } | null> {
    const result = await this.db.query(
      `SELECT access_token_enc, refresh_token_enc FROM email_oauth_accounts WHERE id = $1`,
      [accountId],
    );
    const row = result.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      accessToken: await decryptToken(businessId, row['access_token_enc'] as string),
      refreshToken: row['refresh_token_enc']
        ? await decryptToken(businessId, row['refresh_token_enc'] as string)
        : null,
    };
  }

  async deleteAccount(accountId: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM email_oauth_accounts WHERE id = $1 AND business_id = $2`,
      [accountId, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async upsertMessage(accountId: string, msg: {
    providerMessageId: string;
    providerThreadId?: string | null;
    folder?: string;
    subject?: string | null;
    fromAddress?: string | null;
    fromName?: string | null;
    toAddresses?: string | null;
    snippet?: string | null;
    bodyHtml?: string | null;
    bodyText?: string | null;
    isRead?: boolean;
    isStarred?: boolean;
    labels?: string[];
    receivedAt?: Date | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO email_oauth_messages
         (account_id, provider_message_id, provider_thread_id, folder, subject,
          from_address, from_name, to_addresses, snippet, body_html, body_text,
          is_read, is_starred, labels, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (account_id, provider_message_id) DO UPDATE SET
         is_read   = EXCLUDED.is_read,
         is_starred = EXCLUDED.is_starred,
         labels    = EXCLUDED.labels,
         synced_at = now()`,
      [
        accountId,
        msg.providerMessageId,
        msg.providerThreadId ?? null,
        msg.folder ?? 'INBOX',
        msg.subject ?? null,
        msg.fromAddress ?? null,
        msg.fromName ?? null,
        msg.toAddresses ?? null,
        msg.snippet ?? null,
        msg.bodyHtml ?? null,
        msg.bodyText ?? null,
        msg.isRead ?? false,
        msg.isStarred ?? false,
        msg.labels ?? [],
        msg.receivedAt?.toISOString() ?? null,
      ],
    );
  }

  async listMessages(accountId: string, opts?: { limit?: number; unreadOnly?: boolean }): Promise<EmailOAuthMessageRecord[]> {
    const conditions = ['account_id = $1'];
    const params: unknown[] = [accountId];
    if (opts?.unreadOnly) { conditions.push('is_read = false'); }
    const result = await this.db.query(
      `SELECT * FROM email_oauth_messages WHERE ${conditions.join(' AND ')}
       ORDER BY received_at DESC NULLS LAST LIMIT $${params.push(opts?.limit ?? 50)}`,
      params,
    );
    return result.rows.map((r) => this.mapMessage(r as Record<string, unknown>));
  }

  private mapAccount(row: Record<string, unknown>): EmailOAuthAccountRecord {
    return {
      id: row['id'] as string,
      businessId: row['business_id'] as string,
      provider: row['provider'] as OAuthProvider,
      emailAddress: row['email_address'] as string,
      displayName: row['display_name'] as string | null,
      tokenExpiresAt: row['token_expires_at'] ? (row['token_expires_at'] as Date).toISOString() : null,
      scopes: row['scopes'] as string | null,
      syncCursor: row['sync_cursor'] as string | null,
      lastSyncedAt: row['last_synced_at'] ? (row['last_synced_at'] as Date).toISOString() : null,
      syncEnabled: row['sync_enabled'] as boolean,
      createdAt: (row['created_at'] as Date).toISOString(),
      updatedAt: (row['updated_at'] as Date).toISOString(),
    };
  }

  private mapMessage(row: Record<string, unknown>): EmailOAuthMessageRecord {
    return {
      id: row['id'] as string,
      accountId: row['account_id'] as string,
      providerMessageId: row['provider_message_id'] as string,
      providerThreadId: row['provider_thread_id'] as string | null,
      folder: row['folder'] as string,
      subject: row['subject'] as string | null,
      fromAddress: row['from_address'] as string | null,
      fromName: row['from_name'] as string | null,
      toAddresses: row['to_addresses'] as string | null,
      snippet: row['snippet'] as string | null,
      bodyHtml: row['body_html'] as string | null,
      bodyText: row['body_text'] as string | null,
      isRead: row['is_read'] as boolean,
      isStarred: row['is_starred'] as boolean,
      labels: row['labels'] as string[],
      receivedAt: row['received_at'] ? (row['received_at'] as Date).toISOString() : null,
      syncedAt: (row['synced_at'] as Date).toISOString(),
    };
  }
}
