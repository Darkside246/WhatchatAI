import type { Queryable } from './types.js';
import type {
  MediaDownloadErrorCategory,
  MediaDownloadStatus,
  MediaProcessingStatus,
  MediaStorageProvider,
  MediaType,
} from '../domain/whatsapp/types.js';

export interface WhatsAppMediaRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  messageId: string | null;
  statusId: string | null;
  contactId: string | null;
  accountId: string | null;
  mediaType: MediaType;
  mimeType: string | null;
  fileName: string | null;
  fileSize: number | null;
  sha256: string | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  storageProvider: MediaStorageProvider;
  storageReference: string | null;
  downloadStatus: MediaDownloadStatus;
  processingStatus: MediaProcessingStatus;
  transcript: string | null;
  aiInterpretation: Record<string, unknown> | null;
  downloadAttempts: number;
  lastAttemptedAt: string | null;
  lastErrorCategory: MediaDownloadErrorCategory | null;
  lastErrorMessage: string | null;
  nextRetryAt: string | null;
  terminalReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface MediaRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  message_id: string | null;
  status_id: string | null;
  contact_id: string | null;
  account_id: string | null;
  media_type: MediaType;
  mime_type: string | null;
  file_name: string | null;
  file_size: string | null;
  sha256: string | null;
  duration_seconds: number | null;
  width: number | null;
  height: number | null;
  storage_provider: MediaStorageProvider;
  storage_reference: string | null;
  download_status: MediaDownloadStatus;
  processing_status: MediaProcessingStatus;
  transcript: string | null;
  ai_interpretation: Record<string, unknown> | null;
  download_attempts: number;
  last_attempted_at: string | null;
  last_error_category: MediaDownloadErrorCategory | null;
  last_error_message: string | null;
  next_retry_at: string | null;
  terminal_reason: string | null;
  created_at: string;
  updated_at: string;
}

// Defense in depth against an accidental raw error object/stack trace
// reaching this column (see Phase 2A proposal section 8's logging
// discipline) - callers are expected to already pass a short, classified
// message, but this caps length regardless of what a caller sends.
const MAX_ERROR_MESSAGE_LENGTH = 300;

function sanitizeErrorMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, ' ').trim();
  return singleLine.length > MAX_ERROR_MESSAGE_LENGTH ? `${singleLine.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…` : singleLine;
}

function toRecord(row: MediaRow): WhatsAppMediaRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    messageId: row.message_id,
    statusId: row.status_id,
    contactId: row.contact_id,
    accountId: row.account_id,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    fileName: row.file_name,
    fileSize: row.file_size === null ? null : Number(row.file_size),
    sha256: row.sha256,
    durationSeconds: row.duration_seconds,
    width: row.width,
    height: row.height,
    storageProvider: row.storage_provider,
    storageReference: row.storage_reference,
    downloadStatus: row.download_status,
    processingStatus: row.processing_status,
    transcript: row.transcript,
    aiInterpretation: row.ai_interpretation,
    downloadAttempts: row.download_attempts,
    lastAttemptedAt: row.last_attempted_at,
    lastErrorCategory: row.last_error_category,
    lastErrorMessage: row.last_error_message,
    nextRetryAt: row.next_retry_at,
    terminalReason: row.terminal_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface InsertMediaInput {
  businessId: string;
  whatsappAccountId: string;
  /** Exactly one of messageId/statusId/contactId/accountId must be set - a media row always belongs to one real owner. */
  messageId?: string | null;
  statusId?: string | null;
  contactId?: string | null;
  accountId?: string | null;
  mediaType: MediaType;
  mimeType?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  durationSeconds?: number | null;
}

export class WhatsAppMediaRepository {
  constructor(private readonly db: Queryable) {}

  async insert(input: InsertMediaInput): Promise<WhatsAppMediaRecord> {
    const messageId = input.messageId ?? null;
    const statusId = input.statusId ?? null;
    const contactId = input.contactId ?? null;
    const accountId = input.accountId ?? null;
    const ownerCount = [messageId, statusId, contactId, accountId].filter((value) => value !== null).length;
    if (ownerCount !== 1) {
      throw new Error('whatsapp_media insert requires exactly one of messageId, statusId, contactId, or accountId');
    }

    const { rows } = await this.db.query<MediaRow>(
      `INSERT INTO whatsapp_media
         (business_id, whatsapp_account_id, message_id, status_id, contact_id, account_id, media_type, mime_type, file_name, file_size, duration_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        messageId,
        statusId,
        contactId,
        accountId,
        input.mediaType,
        input.mimeType ?? null,
        input.fileName ?? null,
        input.fileSize ?? null,
        input.durationSeconds ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_media insert returned no row');
    return toRecord(row);
  }

  async setDownloadResult(
    id: string,
    status: MediaDownloadStatus,
    storageReference: string | null,
    sha256: string | null,
    fileSize: number | null = null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_media
       SET download_status = $2, storage_reference = $3, storage_provider = 'local', sha256 = $4,
           file_size = COALESCE($5, file_size), updated_at = now()
       WHERE id = $1`,
      [id, status, storageReference, sha256, fileSize],
    );
  }

  async setDownloading(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_media SET download_status = 'downloading', updated_at = now() WHERE id = $1`,
      [id],
    );
  }

  /**
   * Phase 2B guarded retry state machine (see
   * docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md sections 2/6). Every
   * transition below is a conditional `UPDATE ... WHERE download_status =
   * <expected>` rather than an unconditional write, so a duplicate job
   * delivery, a crash-recovery sweep racing a real in-flight download, or
   * two concurrent attempts targeting the same row all resolve safely: the
   * transition that arrives second finds the row no longer in the expected
   * state and affects zero rows. Callers must check the returned boolean
   * rather than assuming success - this is the actual concurrency guard,
   * not an optimization. Scoped to the message/status media pipeline only;
   * profile pictures continue using the unconditional setDownloading/
   * setDownloadResult above (see the Phase 2A proposal's scope note).
   */
  async beginDownloadAttempt(
    id: string,
    fromStatuses: MediaDownloadStatus[],
  ): Promise<{ started: boolean; attempts: number }> {
    const result = await this.db.query<{ download_attempts: number }>(
      `UPDATE whatsapp_media
       SET download_status = 'downloading', download_attempts = download_attempts + 1,
           last_attempted_at = now(), updated_at = now()
       WHERE id = $1 AND download_status = ANY($2::text[])
       RETURNING download_attempts`,
      [id, fromStatuses],
    );
    const row = result.rows[0];
    return row ? { started: true, attempts: row.download_attempts } : { started: false, attempts: 0 };
  }

  /** downloading -> downloaded: real, terminal success. */
  async completeDownload(id: string, storageReference: string, sha256: string, fileSize: number): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE whatsapp_media
       SET download_status = 'downloaded', storage_reference = $2, storage_provider = 'local', sha256 = $3,
           file_size = $4, next_retry_at = NULL, terminal_reason = NULL, updated_at = now()
       WHERE id = $1 AND download_status = 'downloading'`,
      [id, storageReference, sha256, fileSize],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** downloading -> retry_scheduled: a classified-retryable failure, attempts remain. */
  async scheduleRetry(
    id: string,
    category: MediaDownloadErrorCategory,
    errorMessage: string,
    nextRetryAt: Date,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE whatsapp_media
       SET download_status = 'retry_scheduled', last_error_category = $2, last_error_message = $3,
           next_retry_at = $4, updated_at = now()
       WHERE id = $1 AND download_status = 'downloading'`,
      [id, category, sanitizeErrorMessage(errorMessage), nextRetryAt.toISOString()],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /** downloading -> failed | unavailable: a terminal outcome (retries exhausted, non-retryable, or 404/410). */
  async failTerminally(
    id: string,
    status: Extract<MediaDownloadStatus, 'failed' | 'unavailable'>,
    category: MediaDownloadErrorCategory | null,
    errorMessage: string | null,
    terminalReason: string,
  ): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE whatsapp_media
       SET download_status = $2, last_error_category = $3, last_error_message = $4, terminal_reason = $5,
           next_retry_at = NULL, updated_at = now()
       WHERE id = $1 AND download_status = 'downloading'`,
      [id, status, category, errorMessage ? sanitizeErrorMessage(errorMessage) : null, terminalReason],
    );
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Crash-recovery sweep support: rows a worker started downloading and
   * never finished (process crash/restart mid-download - see
   * sweepStaleDownloadingMedia in incomingMessagesWorker.ts). Mirrors the
   * existing findStaleRingingCalls/findStaleRunning/findStalePending sweep
   * queries elsewhere in this codebase.
   */
  async findStaleDownloading(staleSeconds: number): Promise<WhatsAppMediaRecord[]> {
    const { rows } = await this.db.query<MediaRow>(
      `SELECT * FROM whatsapp_media
       WHERE download_status = 'downloading' AND updated_at < now() - ($1 || ' seconds')::interval`,
      [staleSeconds],
    );
    return rows.map(toRecord);
  }

  async setTranscript(id: string, transcript: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_media SET transcript = $2, processing_status = 'processed', updated_at = now() WHERE id = $1`,
      [id, transcript],
    );
  }

  async findById(id: string): Promise<WhatsAppMediaRecord | null> {
    const { rows } = await this.db.query<MediaRow>('SELECT * FROM whatsapp_media WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Tenant-scoped lookup - a media id belonging to another business returns
   * null, identically to a genuinely nonexistent id, so a caller can never
   * distinguish "not found" from "exists in another tenant." Prefer this
   * over the bare findById() for any caller that has a businessId in scope.
   */
  async findByIdForBusiness(id: string, businessId: string): Promise<WhatsAppMediaRecord | null> {
    const { rows } = await this.db.query<MediaRow>(
      'SELECT * FROM whatsapp_media WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findByIds(ids: string[]): Promise<WhatsAppMediaRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<MediaRow>('SELECT * FROM whatsapp_media WHERE id = ANY($1)', [ids]);
    return rows.map(toRecord);
  }
}
