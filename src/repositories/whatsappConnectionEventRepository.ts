import type { Queryable } from './types.js';
import type { ConnectionEventType } from '../domain/whatsapp/types.js';

export interface WhatsAppConnectionEventRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  eventType: ConnectionEventType;
  status: string;
  phoneNumber: string | null;
  jid: string | null;
  pushName: string | null;
  startedAt: string;
  errorCode: string | null;
  errorMessage: string | null;
}

interface ConnectionEventRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  event_type: ConnectionEventType;
  status: string;
  phone_number: string | null;
  jid: string | null;
  push_name: string | null;
  started_at: string;
  error_code: string | null;
  error_message: string | null;
}

function toRecord(row: ConnectionEventRow): WhatsAppConnectionEventRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    eventType: row.event_type,
    status: row.status,
    phoneNumber: row.phone_number,
    jid: row.jid,
    pushName: row.push_name,
    startedAt: row.started_at,
    errorCode: row.error_code,
    errorMessage: row.error_message,
  };
}

export interface RecordConnectionEventInput {
  businessId: string;
  whatsappAccountId: string;
  eventType: ConnectionEventType;
  status: string;
  phoneNumber?: string | null;
  jid?: string | null;
  pushName?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export class WhatsAppConnectionEventRepository {
  constructor(private readonly db: Queryable) {}

  /** Connection history is append-only: every real Baileys connection.update becomes one row. */
  async record(input: RecordConnectionEventInput): Promise<WhatsAppConnectionEventRecord> {
    const { rows } = await this.db.query<ConnectionEventRow>(
      `INSERT INTO whatsapp_connection_events
         (business_id, whatsapp_account_id, event_type, status, phone_number, jid, push_name, error_code, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.eventType,
        input.status,
        input.phoneNumber ?? null,
        input.jid ?? null,
        input.pushName ?? null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_connection_events insert returned no row');
    return toRecord(row);
  }

  async listByAccount(whatsappAccountId: string, limit = 50): Promise<WhatsAppConnectionEventRecord[]> {
    const { rows } = await this.db.query<ConnectionEventRow>(
      'SELECT * FROM whatsapp_connection_events WHERE whatsapp_account_id = $1 ORDER BY started_at DESC LIMIT $2',
      [whatsappAccountId, limit],
    );
    return rows.map(toRecord);
  }
}
