import type { Queryable } from './types.js';
import type { ConnectionStatus, SyncStatus } from '../domain/whatsapp/types.js';
import type { WhatsAppJidKind } from '../domain/whatsapp/jid.js';

export interface WhatsAppAccountRecord {
  id: string;
  businessId: string;
  accountName: string | null;
  whatsappJid: string | null;
  jidKind: WhatsAppJidKind;
  phoneNumber: string | null;
  pushName: string | null;
  profileName: string | null;
  profilePictureUrl: string | null;
  aboutText: string | null;
  connectionStatus: ConnectionStatus;
  connectedAt: string | null;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastMessageAt: string | null;
  syncStatus: SyncStatus;
  syncStartedAt: string | null;
  syncCompletedAt: string | null;
  syncProgress: number | null;
  lastSyncError: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface AccountRow {
  id: string;
  business_id: string;
  account_name: string | null;
  whatsapp_jid: string | null;
  jid_kind: WhatsAppJidKind;
  phone_number: string | null;
  push_name: string | null;
  profile_name: string | null;
  profile_picture_url: string | null;
  about_text: string | null;
  connection_status: ConnectionStatus;
  connected_at: string | null;
  last_connected_at: string | null;
  last_disconnected_at: string | null;
  last_message_at: string | null;
  sync_status: SyncStatus;
  sync_started_at: string | null;
  sync_completed_at: string | null;
  sync_progress: string | null;
  last_sync_error: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: AccountRow): WhatsAppAccountRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    accountName: row.account_name,
    whatsappJid: row.whatsapp_jid,
    jidKind: row.jid_kind,
    phoneNumber: row.phone_number,
    pushName: row.push_name,
    profileName: row.profile_name,
    profilePictureUrl: row.profile_picture_url,
    aboutText: row.about_text,
    connectionStatus: row.connection_status,
    connectedAt: row.connected_at,
    lastConnectedAt: row.last_connected_at,
    lastDisconnectedAt: row.last_disconnected_at,
    lastMessageAt: row.last_message_at,
    syncStatus: row.sync_status,
    syncStartedAt: row.sync_started_at,
    syncCompletedAt: row.sync_completed_at,
    syncProgress: row.sync_progress === null ? null : Number(row.sync_progress),
    lastSyncError: row.last_sync_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface UpsertConnectedAccountInput {
  businessId: string;
  whatsappJid: string;
  jidKind: WhatsAppJidKind;
  phoneNumber: string | null;
  pushName: string | null;
  connectionStatus: ConnectionStatus;
}

export class WhatsAppAccountRepository {
  constructor(private readonly db: Queryable) {}

  /** Upserts the real connected account by (business_id, whatsapp_jid). */
  async upsertConnected(input: UpsertConnectedAccountInput): Promise<WhatsAppAccountRecord> {
    const { rows } = await this.db.query<AccountRow>(
      `INSERT INTO whatsapp_accounts
         (business_id, whatsapp_jid, jid_kind, phone_number, push_name,
          connection_status, connected_at, last_connected_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now())
       ON CONFLICT (business_id, whatsapp_jid) WHERE whatsapp_jid IS NOT NULL AND deleted_at IS NULL
       DO UPDATE SET
         jid_kind = EXCLUDED.jid_kind,
         phone_number = EXCLUDED.phone_number,
         push_name = EXCLUDED.push_name,
         connection_status = EXCLUDED.connection_status,
         connected_at = now(),
         last_connected_at = now(),
         updated_at = now()
       RETURNING *`,
      [input.businessId, input.whatsappJid, input.jidKind, input.phoneNumber, input.pushName, input.connectionStatus],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_accounts upsert returned no row');
    return toRecord(row);
  }

  async markDisconnected(id: string, status: ConnectionStatus): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_accounts
       SET connection_status = $2, last_disconnected_at = now(), updated_at = now()
       WHERE id = $1`,
      [id, status],
    );
  }

  async findById(id: string): Promise<WhatsAppAccountRecord | null> {
    const { rows } = await this.db.query<AccountRow>('SELECT * FROM whatsapp_accounts WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByJid(businessId: string, whatsappJid: string): Promise<WhatsAppAccountRecord | null> {
    const { rows } = await this.db.query<AccountRow>(
      `SELECT * FROM whatsapp_accounts
       WHERE business_id = $1 AND whatsapp_jid = $2 AND deleted_at IS NULL`,
      [businessId, whatsappJid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async countByBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(*)::int AS count FROM whatsapp_accounts WHERE business_id = $1 AND deleted_at IS NULL`,
      [businessId],
    );
    return Number(rows[0]?.count ?? 0);
  }

  async markSyncStarted(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_accounts
       SET sync_status = 'in_progress', sync_started_at = now(), sync_completed_at = NULL,
           sync_progress = 0, last_sync_error = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async updateSyncProgress(id: string, progressPercent: number | null): Promise<void> {
    await this.db.query('UPDATE whatsapp_accounts SET sync_progress = $2, updated_at = now() WHERE id = $1', [
      id,
      progressPercent,
    ]);
  }

  async markSyncCompleted(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_accounts
       SET sync_status = 'completed', sync_completed_at = now(), sync_progress = 100, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async markSyncFailed(id: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_accounts SET sync_status = 'failed', last_sync_error = $2, updated_at = now() WHERE id = $1`,
      [id, error],
    );
  }
}
