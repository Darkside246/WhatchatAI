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

export type WellKnownFolderType = 'inbox' | 'sent' | 'drafts' | 'spam' | 'trash' | 'archive' | 'other';

export type EmailOAuthFolderRecord = {
  id: string;
  accountId: string;
  providerFolderId: string;
  displayName: string;
  wellKnownType: WellKnownFolderType;
  parentProviderFolderId: string | null;
  syncCursor: string | null;
  lastSyncedAt: string | null;
  unreadCount: number;
  totalCount: number;
  createdAt: string;
  updatedAt: string;
};

export type EmailOAuthMessageRecord = {
  id: string;
  accountId: string;
  providerMessageId: string;
  providerThreadId: string | null;
  folderId: string;
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

  /** The one deliberately tenant-agnostic listing method - a scheduled sweep genuinely needs every sync-enabled account across every business, same reasoning as writingTwinRepository.ts's own sweepExpiredRawEvents(). */
  async listAllSyncEnabled(): Promise<EmailOAuthAccountRecord[]> {
    const result = await this.db.query(
      `SELECT id, business_id, provider, email_address, display_name, token_expires_at,
              scopes, sync_cursor, last_synced_at, sync_enabled, created_at, updated_at
       FROM email_oauth_accounts WHERE sync_enabled = true ORDER BY created_at`,
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

  /**
   * Tenant-scoped lookup - an accountId belonging to another business
   * returns null, identically to a genuinely nonexistent id (same
   * convention as AiAgentRepository.findByIdForBusiness). Every caller
   * that has a real businessId in scope (the sync service, the router)
   * must use this instead of the bare getById() above, which was
   * previously called with an attacker-suppliable accountId and no
   * ownership check at all - a real cross-tenant read of another
   * business's plaintext synced email content, found and fixed as part
   * of the Email Redesign's folder-sync rework.
   */
  async getByIdForBusiness(accountId: string, businessId: string): Promise<EmailOAuthAccountRecord | null> {
    const account = await this.getById(accountId);
    return account && account.businessId === businessId ? account : null;
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

  // --- Folders (Email Redesign Phase A) ---

  async upsertFolder(accountId: string, businessId: string, folder: {
    providerFolderId: string;
    displayName: string;
    wellKnownType: WellKnownFolderType;
    parentProviderFolderId?: string | null;
  }): Promise<EmailOAuthFolderRecord> {
    const result = await this.db.query(
      `INSERT INTO email_oauth_folders (account_id, business_id, provider_folder_id, display_name, well_known_type, parent_provider_folder_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id, provider_folder_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         well_known_type = EXCLUDED.well_known_type,
         parent_provider_folder_id = EXCLUDED.parent_provider_folder_id,
         updated_at = now()
       RETURNING *`,
      [accountId, businessId, folder.providerFolderId, folder.displayName, folder.wellKnownType, folder.parentProviderFolderId ?? null],
    );
    return this.mapFolder(result.rows[0] as Record<string, unknown>);
  }

  async listFolders(accountId: string): Promise<EmailOAuthFolderRecord[]> {
    const result = await this.db.query(
      `SELECT * FROM email_oauth_folders WHERE account_id = $1 ORDER BY well_known_type, display_name`,
      [accountId],
    );
    return result.rows.map((r) => this.mapFolder(r as Record<string, unknown>));
  }

  async getFolderById(folderId: string): Promise<EmailOAuthFolderRecord | null> {
    const result = await this.db.query(`SELECT * FROM email_oauth_folders WHERE id = $1`, [folderId]);
    return result.rows[0] ? this.mapFolder(result.rows[0] as Record<string, unknown>) : null;
  }

  async updateFolderSyncCursor(folderId: string, cursor: string | null): Promise<void> {
    await this.db.query(
      `UPDATE email_oauth_folders SET sync_cursor = $1, last_synced_at = now(), updated_at = now() WHERE id = $2`,
      [cursor, folderId],
    );
  }

  /** Real counts from the messages actually stored, never estimated - refreshed after each folder sync. */
  async refreshFolderCounts(folderId: string): Promise<void> {
    await this.db.query(
      `UPDATE email_oauth_folders f SET
         total_count = (SELECT count(*) FROM email_oauth_messages m WHERE m.folder_id = f.id),
         unread_count = (SELECT count(*) FROM email_oauth_messages m WHERE m.folder_id = f.id AND m.is_read = false),
         updated_at = now()
       WHERE f.id = $1`,
      [folderId],
    );
  }

  async upsertMessage(accountId: string, businessId: string, msg: {
    providerMessageId: string;
    providerThreadId?: string | null;
    folderId: string;
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
         (account_id, business_id, provider_message_id, provider_thread_id, folder_id, subject,
          from_address, from_name, to_addresses, snippet, body_html, body_text,
          is_read, is_starred, labels, received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (account_id, folder_id, provider_message_id) DO UPDATE SET
         is_read    = EXCLUDED.is_read,
         is_starred = EXCLUDED.is_starred,
         labels     = EXCLUDED.labels,
         -- Also refreshed on every re-sync (not just read/starred/labels) so
         -- a real extraction bug fixed later (e.g. Gmail's raw-HTML-into-
         -- body_text bug, emailSyncService.ts's extractGmailBody) self-heals
         -- on this account's very next scheduled sync, rather than leaving
         -- every already-synced message wrong forever.
         subject      = EXCLUDED.subject,
         from_address = EXCLUDED.from_address,
         from_name    = EXCLUDED.from_name,
         to_addresses = EXCLUDED.to_addresses,
         snippet      = EXCLUDED.snippet,
         body_html    = EXCLUDED.body_html,
         body_text    = EXCLUDED.body_text,
         synced_at  = now()`,
      [
        accountId,
        businessId,
        msg.providerMessageId,
        msg.providerThreadId ?? null,
        msg.folderId,
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

  /** Tenant-scoped single-message lookup (joined through the owning account, since messages carry no direct business_id) - used by the AI reply-drafting flow, never exposed to a route accepting a bare messageId with no businessId check. */
  async getMessageByIdForBusiness(messageId: string, businessId: string): Promise<EmailOAuthMessageRecord | null> {
    const result = await this.db.query(
      `SELECT m.* FROM email_oauth_messages m
       JOIN email_oauth_accounts a ON a.id = m.account_id
       WHERE m.id = $1 AND a.business_id = $2`,
      [messageId, businessId],
    );
    return result.rows[0] ? this.mapMessage(result.rows[0] as Record<string, unknown>) : null;
  }

  /** Removes AURA's own local copy only, after the real provider-side trash/delete has already succeeded (see emailSyncService.ts's deleteOAuthMessage) - never the other way around, so a failed provider call never leaves this app showing a message that's actually still real and unread in the person's real mailbox. Same tenant-safe join-through-account as getMessageByIdForBusiness. */
  async deleteMessage(messageId: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM email_oauth_messages m
       USING email_oauth_accounts a
       WHERE m.id = $1 AND a.id = m.account_id AND a.business_id = $2`,
      [messageId, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async listMessages(accountId: string, opts?: { limit?: number; unreadOnly?: boolean; folderId?: string }): Promise<EmailOAuthMessageRecord[]> {
    const conditions = ['account_id = $1'];
    const params: unknown[] = [accountId];
    if (opts?.unreadOnly) { conditions.push('is_read = false'); }
    if (opts?.folderId) { conditions.push(`folder_id = $${params.push(opts.folderId)}`); }
    const result = await this.db.query(
      `SELECT * FROM email_oauth_messages WHERE ${conditions.join(' AND ')}
       ORDER BY received_at DESC NULLS LAST LIMIT $${params.push(opts?.limit ?? 50)}`,
      params,
    );
    return result.rows.map((r) => this.mapMessage(r as Record<string, unknown>));
  }

  /** Real, distinct senders seen across this account's synced mail - the Email panel's Contacts card, never a fabricated address book. */
  async listDistinctSenders(accountId: string, limit = 25): Promise<{ address: string; name: string | null }[]> {
    const result = await this.db.query(
      `SELECT from_address AS address, max(from_name) AS name, count(*) AS message_count
       FROM email_oauth_messages
       WHERE account_id = $1 AND from_address IS NOT NULL
       GROUP BY from_address
       ORDER BY message_count DESC
       LIMIT $2`,
      [accountId, limit],
    );
    return result.rows.map((r) => ({ address: (r as Record<string, unknown>)['address'] as string, name: (r as Record<string, unknown>)['name'] as string | null }));
  }

  // Timestamp columns come back as plain ISO strings, not Date objects - the
  // pool's global TIMESTAMPTZ type parser (src/db/pool.ts) already converts
  // them, specifically so no repository ever needs (or should call)
  // .toISOString() on one. Same class of bug already documented in
  // productAccountRepository.ts, legalDocumentRepository.ts and userConsentRepository.ts.
  private mapAccount(row: Record<string, unknown>): EmailOAuthAccountRecord {
    return {
      id: row['id'] as string,
      businessId: row['business_id'] as string,
      provider: row['provider'] as OAuthProvider,
      emailAddress: row['email_address'] as string,
      displayName: row['display_name'] as string | null,
      tokenExpiresAt: row['token_expires_at'] as string | null,
      scopes: row['scopes'] as string | null,
      syncCursor: row['sync_cursor'] as string | null,
      lastSyncedAt: row['last_synced_at'] as string | null,
      syncEnabled: row['sync_enabled'] as boolean,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  private mapFolder(row: Record<string, unknown>): EmailOAuthFolderRecord {
    return {
      id: row['id'] as string,
      accountId: row['account_id'] as string,
      providerFolderId: row['provider_folder_id'] as string,
      displayName: row['display_name'] as string,
      wellKnownType: row['well_known_type'] as WellKnownFolderType,
      parentProviderFolderId: row['parent_provider_folder_id'] as string | null,
      syncCursor: row['sync_cursor'] as string | null,
      lastSyncedAt: row['last_synced_at'] as string | null,
      unreadCount: row['unread_count'] as number,
      totalCount: row['total_count'] as number,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  private mapMessage(row: Record<string, unknown>): EmailOAuthMessageRecord {
    return {
      id: row['id'] as string,
      accountId: row['account_id'] as string,
      providerMessageId: row['provider_message_id'] as string,
      providerThreadId: row['provider_thread_id'] as string | null,
      folderId: row['folder_id'] as string,
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
      receivedAt: row['received_at'] as string | null,
      syncedAt: row['synced_at'] as string,
    };
  }
}
