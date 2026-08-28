import type { Queryable } from './types.js';

export const SCHEDULED_STATUS_STATES = ['DRAFT', 'SCHEDULED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'CANCELLED'] as const;
export type ScheduledStatusState = (typeof SCHEDULED_STATUS_STATES)[number];
export type ScheduledStatusType = 'text' | 'image' | 'video';

export interface ScheduledStatusRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  statusType: ScheduledStatusType;
  textContent: string | null;
  caption: string | null;
  backgroundColor: string | null;
  mediaStorageReference: string | null;
  mediaMimeType: string | null;
  scheduledAt: string;
  status: ScheduledStatusState;
  publishedAt: string | null;
  lastError: string | null;
  /** The real WhatsApp message key returned at publish time. NULL means this post cannot be recalled. */
  publishedWhatsappMessageId: string | null;
  /** 'revoke_sent' means WhatsApp accepted the recall instruction, not that every viewer's device dropped it. */
  revokeStatus: 'none' | 'requested' | 'revoke_sent' | 'failed';
  revokeSentAt: string | null;
  revokeError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ScheduledStatusRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  created_by: string;
  status_type: ScheduledStatusType;
  text_content: string | null;
  caption: string | null;
  background_color: string | null;
  media_storage_reference: string | null;
  media_mime_type: string | null;
  scheduled_at: string;
  status: ScheduledStatusState;
  published_at: string | null;
  last_error: string | null;
  published_whatsapp_message_id: string | null;
  revoke_status: 'none' | 'requested' | 'revoke_sent' | 'failed';
  revoke_sent_at: string | null;
  revoke_error: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ScheduledStatusRow): ScheduledStatusRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    createdBy: row.created_by,
    statusType: row.status_type,
    textContent: row.text_content,
    caption: row.caption,
    backgroundColor: row.background_color,
    mediaStorageReference: row.media_storage_reference,
    mediaMimeType: row.media_mime_type,
    scheduledAt: row.scheduled_at,
    status: row.status,
    publishedAt: row.published_at,
    lastError: row.last_error,
    publishedWhatsappMessageId: row.published_whatsapp_message_id ?? null,
    revokeStatus: row.revoke_status ?? 'none',
    revokeSentAt: row.revoke_sent_at ?? null,
    revokeError: row.revoke_error ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateScheduledStatusInput {
  businessId: string;
  whatsappAccountId: string;
  createdBy: string;
  statusType: ScheduledStatusType;
  textContent?: string | null;
  caption?: string | null;
  backgroundColor?: string | null;
  mediaStorageReference?: string | null;
  mediaMimeType?: string | null;
  scheduledAt: string;
}

export class ScheduledStatusRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateScheduledStatusInput): Promise<ScheduledStatusRecord> {
    const { rows } = await this.db.query<ScheduledStatusRow>(
      `INSERT INTO scheduled_statuses
         (business_id, whatsapp_account_id, created_by, status_type, text_content, caption, background_color, media_storage_reference, media_mime_type, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.createdBy,
        input.statusType,
        input.textContent ?? null,
        input.caption ?? null,
        input.backgroundColor ?? null,
        input.mediaStorageReference ?? null,
        input.mediaMimeType ?? null,
        input.scheduledAt,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('scheduled_statuses insert returned no row');
    return toRecord(row);
  }

  async findByIdForBusiness(businessId: string, id: string): Promise<ScheduledStatusRecord | null> {
    const { rows } = await this.db.query<ScheduledStatusRow>('SELECT * FROM scheduled_statuses WHERE id = $1 AND business_id = $2', [id, businessId]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<ScheduledStatusRecord | null> {
    const { rows } = await this.db.query<ScheduledStatusRow>('SELECT * FROM scheduled_statuses WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listForBusiness(businessId: string): Promise<ScheduledStatusRecord[]> {
    const { rows } = await this.db.query<ScheduledStatusRow>(
      'SELECT * FROM scheduled_statuses WHERE business_id = $1 ORDER BY scheduled_at DESC',
      [businessId],
    );
    return rows.map(toRecord);
  }

  async updateDraft(id: string, input: { textContent?: string | null; caption?: string | null; backgroundColor?: string | null; scheduledAt?: string }): Promise<ScheduledStatusRecord | null> {
    const { rows } = await this.db.query<ScheduledStatusRow>(
      `UPDATE scheduled_statuses SET
         text_content = COALESCE($2, text_content),
         caption = COALESCE($3, caption),
         background_color = COALESCE($4, background_color),
         scheduled_at = COALESCE($5, scheduled_at),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, input.textContent ?? null, input.caption ?? null, input.backgroundColor ?? null, input.scheduledAt ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async updateStatus(id: string, status: ScheduledStatusState, extra: { publishedAt?: boolean; lastError?: string | null } = {}): Promise<ScheduledStatusRecord | null> {
    const { rows } = await this.db.query<ScheduledStatusRow>(
      `UPDATE scheduled_statuses SET
         status = $2,
         published_at = CASE WHEN $3 THEN now() ELSE published_at END,
         last_error = COALESCE($4, last_error),
         updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [id, status, extra.publishedAt ?? false, extra.lastError ?? null],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Records the real WhatsApp key the publish returned - the only thing that makes a later recall possible. */
  async recordPublishedMessageId(id: string, whatsappMessageId: string): Promise<void> {
    await this.db.query('UPDATE scheduled_statuses SET published_whatsapp_message_id = $2, updated_at = now() WHERE id = $1', [
      id,
      whatsappMessageId,
    ]);
  }

  /**
   * Claims a published status for recall. Returns false when it is not
   * recallable - never published, no stored key, or a recall already ran -
   * so the caller must not enqueue a job.
   */
  async markRevokeRequested(id: string, businessId: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE scheduled_statuses
         SET revoke_status = 'requested', revoke_error = NULL, updated_at = now()
       WHERE id = $1
         AND business_id = $2
         AND status = 'PUBLISHED'
         AND published_whatsapp_message_id IS NOT NULL
         AND revoke_status IN ('none', 'failed')`,
      [id, businessId],
    );
    return (rowCount ?? 0) > 0;
  }

  async markRevokeSent(id: string): Promise<void> {
    await this.db.query(
      `UPDATE scheduled_statuses
         SET revoke_status = 'revoke_sent', revoke_sent_at = now(), revoke_error = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async markRevokeFailed(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE scheduled_statuses SET revoke_status = 'failed', revoke_error = $2, updated_at = now() WHERE id = $1`,
      [id, reason.slice(0, 500)],
    );
  }

  // Hard-delete a terminal-state scheduled status (CANCELLED, FAILED, or PUBLISHED with no pending revoke).
  async deleteTerminal(businessId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `DELETE FROM scheduled_statuses
       WHERE id = $1 AND business_id = $2
         AND (
           status IN ('CANCELLED', 'FAILED')
           OR (status = 'PUBLISHED' AND revoke_status IN ('none', 'revoke_sent', 'failed'))
         )`,
      [id, businessId],
    );
    return (rowCount ?? 0) > 0;
  }
}
