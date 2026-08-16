import type { Queryable } from './types.js';
import type { CallStatus, CallType, MessageDirection } from '../domain/whatsapp/types.js';

export interface WhatsAppCallRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  callId: string;
  remoteJid: string;
  remotePhoneNumber: string | null;
  callType: CallType;
  direction: MessageDirection;
  status: CallStatus;
  isVideo: boolean;
  isGroup: boolean;
  startedAt: string | null;
  acceptedAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  rawMetadata: Record<string, unknown>;
}

interface CallRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  call_id: string;
  remote_jid: string;
  remote_phone_number: string | null;
  call_type: CallType;
  direction: MessageDirection;
  status: CallStatus;
  is_video: boolean;
  is_group: boolean;
  started_at: string | null;
  accepted_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  raw_metadata: Record<string, unknown>;
}

function toRecord(row: CallRow): WhatsAppCallRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    callId: row.call_id,
    remoteJid: row.remote_jid,
    remotePhoneNumber: row.remote_phone_number,
    callType: row.call_type,
    direction: row.direction,
    status: row.status,
    isVideo: row.is_video,
    isGroup: row.is_group,
    startedAt: row.started_at,
    acceptedAt: row.accepted_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds,
    rawMetadata: row.raw_metadata,
  };
}

export interface UpsertCallEventInput {
  businessId: string;
  whatsappAccountId: string;
  callId: string;
  remoteJid: string;
  remotePhoneNumber?: string | null;
  callType: CallType;
  direction: MessageDirection;
  status: CallStatus;
  isVideo?: boolean;
  isGroup?: boolean;
  startedAt?: string | null;
  acceptedAt?: string | null;
  endedAt?: string | null;
  durationSeconds?: number | null;
  rawMetadata?: Record<string, unknown>;
}

export class WhatsAppCallRepository {
  constructor(private readonly db: Queryable) {}

  /** One real call is a stream of events (offer -> ringing -> accept -> ended); each event updates the same row. */
  async upsertEvent(input: UpsertCallEventInput): Promise<WhatsAppCallRecord> {
    const { rows } = await this.db.query<CallRow>(
      `INSERT INTO whatsapp_calls
         (business_id, whatsapp_account_id, call_id, remote_jid, remote_phone_number,
          call_type, direction, status, is_video, is_group, started_at, accepted_at, ended_at, duration_seconds, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       ON CONFLICT (business_id, whatsapp_account_id, call_id)
       DO UPDATE SET
         status = EXCLUDED.status,
         accepted_at = COALESCE(EXCLUDED.accepted_at, whatsapp_calls.accepted_at),
         ended_at = COALESCE(EXCLUDED.ended_at, whatsapp_calls.ended_at),
         duration_seconds = COALESCE(EXCLUDED.duration_seconds, whatsapp_calls.duration_seconds),
         raw_metadata = whatsapp_calls.raw_metadata || EXCLUDED.raw_metadata,
         updated_at = now()
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.callId,
        input.remoteJid,
        input.remotePhoneNumber ?? null,
        input.callType,
        input.direction,
        input.status,
        input.isVideo ?? false,
        input.isGroup ?? false,
        input.startedAt ?? null,
        input.acceptedAt ?? null,
        input.endedAt ?? null,
        input.durationSeconds ?? null,
        JSON.stringify(input.rawMetadata ?? {}),
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_calls upsert returned no row');
    return toRecord(row);
  }

  async findByCallId(businessId: string, whatsappAccountId: string, callId: string): Promise<WhatsAppCallRecord | null> {
    const { rows } = await this.db.query<CallRow>(
      `SELECT * FROM whatsapp_calls WHERE business_id = $1 AND whatsapp_account_id = $2 AND call_id = $3`,
      [businessId, whatsappAccountId, callId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByAccount(businessId: string, whatsappAccountId: string, limit = 100): Promise<WhatsAppCallRecord[]> {
    const { rows } = await this.db.query<CallRow>(
      `SELECT * FROM whatsapp_calls WHERE business_id = $1 AND whatsapp_account_id = $2
       ORDER BY COALESCE(started_at, created_at) DESC LIMIT $3`,
      [businessId, whatsappAccountId, limit],
    );
    return rows.map(toRecord);
  }

  /**
   * Real, documented timeout rule: WhatsApp's own client rings for roughly
   * 45-60s before a call goes to "missed" on the device. A call still
   * sitting in offer/ringing well past that window with no further event
   * from Baileys is treated the same way - never left stuck forever.
   */
  async findStaleRingingCalls(thresholdSeconds: number, limit = 100): Promise<WhatsAppCallRecord[]> {
    const { rows } = await this.db.query<CallRow>(
      `SELECT * FROM whatsapp_calls
       WHERE status IN ('offer', 'ringing')
         AND started_at IS NOT NULL
         AND started_at < now() - ($1 || ' seconds')::interval
       ORDER BY started_at ASC
       LIMIT $2`,
      [thresholdSeconds, limit],
    );
    return rows.map(toRecord);
  }
}
