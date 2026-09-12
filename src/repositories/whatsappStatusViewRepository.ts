import type { Queryable } from './types.js';

export interface WhatsAppStatusViewRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  statusWhatsappId: string;
  viewerJid: string;
  viewedAt: string;
  createdAt: string;
}

interface StatusViewRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  status_whatsapp_id: string;
  viewer_jid: string;
  viewed_at: string;
  created_at: string;
}

function toRecord(row: StatusViewRow): WhatsAppStatusViewRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    statusWhatsappId: row.status_whatsapp_id,
    viewerJid: row.viewer_jid,
    viewedAt: row.viewed_at,
    createdAt: row.created_at,
  };
}

export interface RecordStatusViewInput {
  businessId: string;
  whatsappAccountId: string;
  statusWhatsappId: string;
  viewerJid: string;
  viewedAt: string;
}

export class WhatsAppStatusViewRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * One person watched one status.
   *
   * Idempotent, and deliberately keeps the FIRST time we were told rather
   * than the latest: WhatsApp replays receipts after a reconnect, and
   * "watched it at 9:04" becoming "watched it at 11:20 (when we came back
   * online)" would turn a real engagement timestamp into a record of our
   * own downtime.
   */
  async record(input: RecordStatusViewInput): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `INSERT INTO whatsapp_status_views (business_id, whatsapp_account_id, status_whatsapp_id, viewer_jid, viewed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (business_id, whatsapp_account_id, status_whatsapp_id, viewer_jid) DO NOTHING`,
      [input.businessId, input.whatsappAccountId, input.statusWhatsappId, input.viewerJid, input.viewedAt],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Every viewer of one status, most recent first. Business-scoped so a status id can never be probed cross-tenant. */
  async listForStatus(businessId: string, statusWhatsappId: string, limit = 500): Promise<WhatsAppStatusViewRecord[]> {
    const { rows } = await this.db.query<StatusViewRow>(
      `SELECT * FROM whatsapp_status_views
       WHERE business_id = $1 AND status_whatsapp_id = $2
       ORDER BY viewed_at DESC LIMIT $3`,
      [businessId, statusWhatsappId, limit],
    );
    return rows.map(toRecord);
  }
}
