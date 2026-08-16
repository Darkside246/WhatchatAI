import type { Queryable } from './types.js';
import type { StatusType } from '../domain/whatsapp/types.js';

export interface WhatsAppStatusRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  statusId: string;
  publisherJid: string;
  statusType: StatusType;
  textContent: string | null;
  mediaId: string | null;
  createdAt: string;
  expiresAt: string | null;
  viewCount: number | null;
  /** True only when this call itself created the row - false when the unique (business, account, status_id) index already had it. */
  wasInserted: boolean;
}

interface StatusRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  status_id: string;
  publisher_jid: string;
  status_type: StatusType;
  text_content: string | null;
  media_id: string | null;
  created_at: string;
  expires_at: string | null;
  view_count: number | null;
}

function toRecord(row: StatusRow, wasInserted: boolean): WhatsAppStatusRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    statusId: row.status_id,
    publisherJid: row.publisher_jid,
    statusType: row.status_type,
    textContent: row.text_content,
    mediaId: row.media_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    viewCount: row.view_count,
    wasInserted,
  };
}

export interface InsertStatusInput {
  businessId: string;
  whatsappAccountId: string;
  statusId: string;
  publisherJid: string;
  statusType: StatusType;
  textContent?: string | null;
  mediaId?: string | null;
  expiresAt?: string | null;
}

export class WhatsAppStatusRepository {
  constructor(private readonly db: Queryable) {}

  async insert(input: InsertStatusInput): Promise<WhatsAppStatusRecord> {
    const { rows } = await this.db.query<StatusRow>(
      `INSERT INTO whatsapp_statuses
         (business_id, whatsapp_account_id, status_id, publisher_jid, status_type, text_content, media_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (business_id, whatsapp_account_id, status_id) DO NOTHING
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.statusId,
        input.publisherJid,
        input.statusType,
        input.textContent ?? null,
        input.mediaId ?? null,
        input.expiresAt ?? null,
      ],
    );

    if (rows[0]) return toRecord(rows[0], true);

    const { rows: existingRows } = await this.db.query<StatusRow>(
      `SELECT * FROM whatsapp_statuses WHERE business_id = $1 AND whatsapp_account_id = $2 AND status_id = $3`,
      [input.businessId, input.whatsappAccountId, input.statusId],
    );
    const existing = existingRows[0];
    if (!existing) throw new Error('whatsapp_statuses insert conflicted but no existing row found');
    return toRecord(existing, false);
  }

  async attachMedia(id: string, mediaId: string): Promise<void> {
    await this.db.query('UPDATE whatsapp_statuses SET media_id = $2 WHERE id = $1', [id, mediaId]);
  }

  async listByAccount(businessId: string, whatsappAccountId: string, limit = 100): Promise<WhatsAppStatusRecord[]> {
    const { rows } = await this.db.query<StatusRow>(
      `SELECT * FROM whatsapp_statuses WHERE business_id = $1 AND whatsapp_account_id = $2
       AND (expires_at IS NULL OR expires_at > now())
       ORDER BY created_at DESC LIMIT $3`,
      [businessId, whatsappAccountId, limit],
    );
    return rows.map((row) => toRecord(row, false));
  }

  /** One real query for the whole chat list - which publishers currently have a real, non-expired status (WhatsApp's own "status ring" signal). */
  async listActivePublisherJids(businessId: string, whatsappAccountId: string): Promise<string[]> {
    const { rows } = await this.db.query<{ publisher_jid: string }>(
      `SELECT DISTINCT publisher_jid FROM whatsapp_statuses
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND (expires_at IS NULL OR expires_at > now())`,
      [businessId, whatsappAccountId],
    );
    return rows.map((row) => row.publisher_jid);
  }

  /** Reconciliation read: statuses whose publisher has no matching contact record. Report-only. */
  async countUnresolvedPublishers(businessId: string, whatsappAccountId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT count(DISTINCT s.publisher_jid) FROM whatsapp_statuses s
       WHERE s.business_id = $1 AND s.whatsapp_account_id = $2
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_contacts c
           WHERE c.business_id = s.business_id AND c.whatsapp_account_id = s.whatsapp_account_id
             AND c.whatsapp_jid = s.publisher_jid AND c.deleted_at IS NULL
         )`,
      [businessId, whatsappAccountId],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
