import type { Queryable } from './types.js';
import type { SyncJobStatus, SyncType } from '../domain/whatsapp/types.js';

export interface WhatsAppSyncJobRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  syncType: SyncType;
  status: SyncJobStatus;
  startedAt: string | null;
  completedAt: string | null;
  progressPercent: number | null;
  chatsProcessed: number;
  contactsProcessed: number;
  groupsProcessed: number;
  messagesProcessed: number;
  mediaProcessed: number;
  errorsCount: number;
  lastError: string | null;
}

interface SyncJobRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  sync_type: SyncType;
  status: SyncJobStatus;
  started_at: string | null;
  completed_at: string | null;
  progress_percent: string | null;
  chats_processed: number;
  contacts_processed: number;
  groups_processed: number;
  messages_processed: number;
  media_processed: number;
  errors_count: number;
  last_error: string | null;
}

function toRecord(row: SyncJobRow): WhatsAppSyncJobRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    syncType: row.sync_type,
    status: row.status,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    progressPercent: row.progress_percent === null ? null : Number(row.progress_percent),
    chatsProcessed: row.chats_processed,
    contactsProcessed: row.contacts_processed,
    groupsProcessed: row.groups_processed,
    messagesProcessed: row.messages_processed,
    mediaProcessed: row.media_processed,
    errorsCount: row.errors_count,
    lastError: row.last_error,
  };
}

export class WhatsAppSyncJobRepository {
  constructor(private readonly db: Queryable) {}

  async create(businessId: string, whatsappAccountId: string, syncType: SyncType): Promise<WhatsAppSyncJobRecord> {
    const { rows } = await this.db.query<SyncJobRow>(
      `INSERT INTO whatsapp_sync_jobs (business_id, whatsapp_account_id, sync_type, status)
       VALUES ($1, $2, $3, 'pending')
       RETURNING *`,
      [businessId, whatsappAccountId, syncType],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_sync_jobs insert returned no row');
    return toRecord(row);
  }

  async markRunning(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_sync_jobs SET status = 'running', started_at = now(), updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  async markCompleted(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_sync_jobs
       SET status = 'completed', completed_at = now(), progress_percent = 100, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, lastError: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_sync_jobs
       SET status = 'failed', last_error = $2, errors_count = errors_count + 1, updated_at = now()
       WHERE id = $1`,
      [id, lastError],
    );
  }

  /** Completed, but with real recorded errors along the way - never overstated as a clean success. */
  async markPartial(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_sync_jobs
       SET status = 'partial', completed_at = now(), progress_percent = 100, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async findById(id: string): Promise<WhatsAppSyncJobRecord | null> {
    const { rows } = await this.db.query<SyncJobRow>('SELECT * FROM whatsapp_sync_jobs WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * The real resumability mechanism: `activeSyncJobs` in WhatsAppSyncService
   * is in-memory only, so a worker-process restart mid-sync would otherwise
   * spawn a duplicate job row instead of resuming the original (which would
   * then sit stuck at 'running' forever). Called before creating a new job.
   */
  async findRunning(businessId: string, whatsappAccountId: string, syncType: SyncType): Promise<WhatsAppSyncJobRecord | null> {
    const { rows } = await this.db.query<SyncJobRow>(
      `SELECT * FROM whatsapp_sync_jobs
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND sync_type = $3 AND status = 'running'
       ORDER BY created_at DESC LIMIT 1`,
      [businessId, whatsappAccountId, syncType],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async incrementCounts(
    id: string,
    counts: Partial<{
      chatsProcessed: number;
      contactsProcessed: number;
      groupsProcessed: number;
      messagesProcessed: number;
      mediaProcessed: number;
      errorsCount: number;
    }>,
  ): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_sync_jobs
       SET chats_processed = chats_processed + $2,
           contacts_processed = contacts_processed + $3,
           groups_processed = groups_processed + $4,
           messages_processed = messages_processed + $5,
           media_processed = media_processed + $6,
           errors_count = errors_count + $7,
           updated_at = now()
       WHERE id = $1`,
      [
        id,
        counts.chatsProcessed ?? 0,
        counts.contactsProcessed ?? 0,
        counts.groupsProcessed ?? 0,
        counts.messagesProcessed ?? 0,
        counts.mediaProcessed ?? 0,
        counts.errorsCount ?? 0,
      ],
    );
  }
}
