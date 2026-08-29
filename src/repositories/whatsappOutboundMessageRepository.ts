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
  /** Real measured duration of a voice note, probed from the encoded file - null when unknown. */
  mediaDurationSeconds: number | null;
  status: OutboundMessageStatus;
  attemptCount: number;
  lastError: string | null;
  whatsappMessageId: string | null;
  messageId: string | null;
  requestedBy: string;
  createdAt: string;
  sentAt: string | null;
  /** Set the instant before the real Baileys sendMessage call - see markSendAttempted(). Non-null on resume means the previous attempt may already have reached WhatsApp. */
  sendAttemptedAt: string | null;
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
  mediaDurationSeconds?: number | null;
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
  media_duration_seconds: number | null;
  status: OutboundMessageStatus;
  attempt_count: number;
  last_error: string | null;
  whatsapp_message_id: string | null;
  message_id: string | null;
  requested_by: string;
  created_at: string;
  sent_at: string | null;
  send_attempted_at: string | null;
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
    mediaDurationSeconds: row.media_duration_seconds,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    whatsappMessageId: row.whatsapp_message_id,
    messageId: row.message_id,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    sentAt: row.sent_at,
    sendAttemptedAt: row.send_attempted_at,
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
          text_content, caption, media_storage_reference, media_mime_type, media_file_name,
          media_duration_seconds, requested_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        input.mediaDurationSeconds ?? null,
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

  /**
   * Tenant-scoped read - a cross-tenant id returns null, indistinguishable
   * from a genuinely nonexistent one. The boundary lives in this query's
   * own WHERE clause, not in a post-fetch JavaScript comparison.
   */
  async findByIdForBusiness(id: string, businessId: string): Promise<WhatsAppOutboundMessageRecord | null> {
    const { rows } = await this.db.query<OutboundMessageRow>(
      'SELECT * FROM whatsapp_outbound_messages WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
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

  /**
   * Committed the instant before the real Baileys sendMessage call, not
   * bundled into markSending() - the two writes must land on either side of
   * the actual network call so a crash between them is distinguishable from
   * a crash before it. On any later attempt, a non-null send_attempted_at
   * means the previous attempt may already have reached WhatsApp; the
   * caller must treat that as indeterminate, never call sendMessage again.
   */
  async markSendAttempted(id: string): Promise<void> {
    await this.db.query(`UPDATE whatsapp_outbound_messages SET send_attempted_at = now() WHERE id = $1`, [id]);
  }

  /**
   * Undoes markSendAttempted() when this same process is still alive to
   * observe that sendMessage itself threw (nothing was confirmed sent) -
   * that is an ordinary, safely-retryable failure, not the crash-mid-flight
   * scenario the marker exists to catch. Only a send_attempted_at that
   * SURVIVES into a new job invocation (because the process died before
   * reaching this call) means the previous attempt's outcome is genuinely
   * unknown.
   */
  async clearSendAttempted(id: string): Promise<void> {
    await this.db.query(`UPDATE whatsapp_outbound_messages SET send_attempted_at = NULL WHERE id = $1`, [id]);
  }

  /**
   * Terminal, but honestly distinct from markFailed: we do not know whether
   * WhatsApp actually received this message. Never retried automatically -
   * only a human checking the real chat/provider can resolve it.
   */
  async markIndeterminate(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_outbound_messages
       SET status = 'indeterminate', last_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, reason],
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

  /**
   * True when this exact WhatsApp message ID was sent through our own
   * outbound pipeline (AI, a human via the dashboard, Operator Mode, a
   * campaign/funnel - anything that calls WhatsAppOutboundMessageService),
   * regardless of requestedBy. False means the fromMe echo Baileys just
   * delivered was never queued by this app at all - a message typed
   * directly into the WhatsApp client on the linked device itself, since
   * markSent() records whatsapp_message_id the instant our own send call
   * returns, strictly before the echoed messages.upsert event that
   * eventually calls this method even reaches us. See
   * whatsappMessagePersistenceService.ts's manual-reply-detected auto-pause.
   */
  async wasSentByThisApp(whatsappAccountId: string, whatsappMessageId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM whatsapp_outbound_messages WHERE whatsapp_account_id = $1 AND whatsapp_message_id = $2 LIMIT 1`,
      [whatsappAccountId, whatsappMessageId],
    );
    return rows.length > 0;
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

  /** Real dashboard aggregate - real, successfully sent messages grouped by who requested them (never counting queued/failed attempts as if they went out). */
  async countSentByRequesterSince(
    businessId: string,
    whatsappAccountId: string,
    sinceIso: string,
  ): Promise<{ human: number; ai: number }> {
    const { rows } = await this.db.query<{ requested_by: string; count: string }>(
      `SELECT requested_by, count(*)::int AS count FROM whatsapp_outbound_messages
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND status = 'sent' AND sent_at >= $3
       GROUP BY requested_by`,
      [businessId, whatsappAccountId, sinceIso],
    );
    const human = rows.find((row) => row.requested_by === 'human')?.count ?? '0';
    const ai = rows.find((row) => row.requested_by === 'ai')?.count ?? '0';
    return { human: Number(human), ai: Number(ai) };
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
