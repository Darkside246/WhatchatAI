import type { Queryable } from './types.js';
import type { PresenceState } from '../domain/whatsapp/types.js';

export interface WhatsAppPresenceRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  contactJid: string;
  presenceState: PresenceState;
  lastSeenAt: string | null;
  recordedAt: string;
}

interface PresenceRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  contact_jid: string;
  presence_state: PresenceState;
  last_seen_at: string | null;
  recorded_at: string;
}

function toRecord(row: PresenceRow): WhatsAppPresenceRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    contactJid: row.contact_jid,
    presenceState: row.presence_state,
    lastSeenAt: row.last_seen_at,
    recordedAt: row.recorded_at,
  };
}

export class WhatsAppPresenceRepository {
  constructor(private readonly db: Queryable) {}

  /** Presence is an append-only event log - one row per real presence.update event. */
  async record(
    businessId: string,
    whatsappAccountId: string,
    contactJid: string,
    presenceState: PresenceState,
    lastSeenAt: string | null,
  ): Promise<WhatsAppPresenceRecord> {
    const { rows } = await this.db.query<PresenceRow>(
      `INSERT INTO whatsapp_presence (business_id, whatsapp_account_id, contact_jid, presence_state, last_seen_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [businessId, whatsappAccountId, contactJid, presenceState, lastSeenAt],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_presence insert returned no row');
    return toRecord(row);
  }

  async findLatest(
    businessId: string,
    whatsappAccountId: string,
    contactJid: string,
  ): Promise<WhatsAppPresenceRecord | null> {
    const { rows } = await this.db.query<PresenceRow>(
      `SELECT * FROM whatsapp_presence
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND contact_jid = $3
       ORDER BY recorded_at DESC LIMIT 1`,
      [businessId, whatsappAccountId, contactJid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
