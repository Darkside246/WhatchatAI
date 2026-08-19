import type { Queryable } from './types.js';
import type {
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
  created_at: string;
  updated_at: string;
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

  async findByIds(ids: string[]): Promise<WhatsAppMediaRecord[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.db.query<MediaRow>('SELECT * FROM whatsapp_media WHERE id = ANY($1)', [ids]);
    return rows.map(toRecord);
  }
}
