import type { Queryable } from './types.js';
import type { OutboundMessageStatus, OutboundMessageType } from '../domain/whatsapp/types.js';

export interface WhatsAppOutboundMessageRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
  toJid: string;
  idempotencyKey: string;
  messageType: OutboundMessageType;
  textContent: string | null;
  caption: string | null;
  mediaStorageReference: string | null;
  mediaMimeType: string | null;
  mediaFileName: string | null;
  status: OutboundMessageStatus;
  attemptCount: number;
  lastError: string | null;
  whatsappMessageId: string | null;
  messageId: string | null;
  requestedBy: string;
  createdAt: string;
  sentAt: string | null;
  /** True only when this call itself created the row - false when an idempotency-key conflict returned a pre-existing send request. */
  wasCreated: boolean;
}

export interface CreateOutboundMessageInput {
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
  toJid: string;
  idempotencyKey: string;
  messageType: OutboundMessageType;
  textContent?: string | null;
  caption?: string | null;
  mediaStorageReference?: string | null;
  mediaMimeType?: string | null;
  mediaFileName?: string | null;
  /** Defaults to 'human' (the column's own DB default) when omitted. */
  requestedBy?: string;
}

interface OutboundMessageRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  chat_id: string;
  to_jid: string;
  idempotency_key: string;
  message_type: OutboundMessageType;
  text_content: string | null;
  caption: string | null;
  media_storage_reference: string | null;
  media_mime_type: string | null;
  media_file_name: string | null;
  status: OutboundMessageStatus;
  attempt_count: number;
  last_error: string | null;
  whatsapp_message_id: string | null;
  message_id: string | null;
  requested_by: string;
  created_at: string;
  sent_at: string | null;
}

function toRecord(row: OutboundMessageRow, wasCreated: boolean): WhatsAppOutboundMessageRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    chatId: row.chat_id,
    toJid: row.to_jid,
    idempotencyKey: row.idempotency_key,
    messageType: row.message_type,
    textContent: row.text_content,
    caption: row.caption,
    mediaStorageReference: row.media_storage_reference,
    mediaMimeType: row.media_mime_type,
    mediaFileName: row.media_file_name,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    whatsappMessageId: row.whatsapp_message_id,
    messageId: row.message_id,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    wasCreated,
  };
}

export class WhatsAppOutboundMessageRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * The real idempotency guarantee: ON CONFLICT DO NOTHING against the
   * unique (business, account, idempotency_key) index means a retried
   * request with the same key never creates a second row - the caller
   * always gets back the one send request that will actually happen (or
   * already did), never a duplicate real WhatsApp send.
   */
  async createIdempotent(input: CreateOutboundMessageInput): Promise<WhatsAppOutboundMessageRecord> {
    const { rows } = await this.db.query<OutboundMessageRow>(
      `INSERT INTO whatsapp_outbound_messages
         (business_id, whatsapp_account_id, chat_id, to_jid, idempotency_key, message_type,
          text_content, caption, media_storage_reference, media_mime_type, media_file_name, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (business_id, whatsapp_account_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.chatId,
        input.toJid,
        input.idempotencyKey,
        input.messageType,
        input.textContent ?? null,
        input.caption ?? null,
        input.mediaStorageReference ?? null,
        input.mediaMimeType ?? null,
        input.mediaFileName ?? null,
        input.requestedBy ?? 'human',
      ],
    );

    if (rows[0]) return toRecord(rows[0], true);

    // Conflict: a request with this idempotency key already exists - return
    // that real row rather than fabricating a second in-flight send.
    const existing = await this.findByIdempotencyKey(input.businessId, input.whatsappAccountId, input.idempotencyKey);
    if (!existing) throw new Error('whatsapp_outbound_messages idempotent insert conflicted but no existing row found');
    return existing;
  }

  async findByIdempotencyKey(
    businessId: string,
    whatsappAccountId: string,
    idempotencyKey: string,
  ): Promise<WhatsAppOutboundMessageRecord | null> {
    const { rows } = await this.db.query<OutboundMessageRow>(
      `SELECT * FROM whatsapp_outbound_messages
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND idempotency_key = $3`,
      [businessId, whatsappAccountId, idempotencyKey],
    );
    return rows[0] ? toRecord(rows[0], false) : null;
  }

  async findById(id: string): Promise<WhatsAppOutboundMessageRecord | null> {
    const { rows } = await this.db.query<OutboundMessageRow>('SELECT * FROM whatsapp_outbound_messages WHERE id = $1', [
      id,
    ]);
    return rows[0] ? toRecord(rows[0], false) : null;
  }

  async markSending(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_outbound_messages
       SET status = 'sending', attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async markSent(id: string, whatsappMessageId: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_outbound_messages
       SET status = 'sent', whatsapp_message_id = $2, sent_at = now(), last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [id, whatsappMessageId],
    );
  }

  /** Terminal - completed_at-equivalent (sent_at stays null) so a failed send never looks like it went out. */
  async markFailed(id: string, lastError: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_outbound_messages
       SET status = 'failed', last_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, lastError],
    );
  }

  /** Backfilled once the echoed messages.upsert event asynchronously persists the real whatsapp_messages row. */
  async linkPersistedMessage(whatsappAccountId: string, whatsappMessageId: string, messageId: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_outbound_messages
       SET message_id = $3, updated_at = now()
       WHERE whatsapp_account_id = $1 AND whatsapp_message_id = $2 AND message_id IS NULL`,
      [whatsappAccountId, whatsappMessageId, messageId],
    );
  }

  /** Batched read for the message list view - which of these persisted messages the AI reply pipeline sent, vs a human agent. */
  async listAiGeneratedMessageIds(messageIds: string[]): Promise<string[]> {
    if (messageIds.length === 0) return [];
    const { rows } = await this.db.query<{ message_id: string }>(
      `SELECT message_id FROM whatsapp_outbound_messages WHERE message_id = ANY($1) AND requested_by = 'ai'`,
      [messageIds],
    );
    return rows.map((row) => row.message_id);
  }

  /**
   * A send stuck in 'sending' (worker crashed mid-dispatch) with no BullMQ
   * retry left to resolve it - the same honesty problem call/sync-job
   * sweeps exist for, reconciled the same way: never left silently
   * claiming to be in-flight forever.
   */
  async findStalePending(staleAfterSeconds: number): Promise<WhatsAppOutboundMessageRecord[]> {
    const { rows } = await this.db.query<OutboundMessageRow>(
      `SELECT * FROM whatsapp_outbound_messages
       WHERE status IN ('queued', 'sending') AND updated_at < now() - ($1 || ' seconds')::interval`,
      [staleAfterSeconds],
    );
    return rows.map((row) => toRecord(row, false));
  }
}
