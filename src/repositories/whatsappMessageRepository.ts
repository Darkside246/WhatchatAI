import type { Queryable } from './types.js';
import type { MessageDirection, MessageStatus, MessageType } from '../domain/whatsapp/types.js';
import { getEncryptionService } from '../security/encryption/index.js';
import type { StructuredMessagePayload } from '../services/whatsappMessageIngestionService.js';

export interface WhatsAppMessageRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
  whatsappMessageId: string;
  remoteJid: string;
  senderJid: string;
  recipientJid: string | null;
  senderContactId: string | null;
  direction: MessageDirection;
  messageType: MessageType;
  textContent: string | null;
  caption: string | null;
  timestamp: string;
  fromMe: boolean;
  /** Real WhatsApp delete-for-everyone state. 'revoke_sent' means WhatsApp accepted the instruction - NOT that every recipient device removed it. */
  revokeStatus: 'none' | 'requested' | 'revoke_sent' | 'failed';
  revokeSentAt: string | null;
  revokeError: string | null;
  isHistorical: boolean;
  status: MessageStatus;
  hasMedia: boolean;
  mediaId: string | null;
  /** The message this one quotes/replies to (WhatsApp's own reply-to, resolved to our own row id at persist time) - null when this message isn't a reply, or replies to something we never persisted. */
  quotedMessageId: string | null;
  /** WhatsApp's own contextInfo.isForwarded - the sender forwarded this from another chat rather than writing it here. */
  isForwarded: boolean;
  /** Decrypted structured detail for a location / shared contact / poll message. Null for every other type. */
  structuredPayload: StructuredMessagePayload | null;
  /** WhatsApp's own contextInfo.forwardingScore - how many hops it has travelled. WhatsApp's client labels >= 5 "forwarded many times". Null when no score was sent. */
  forwardingScore: number | null;
  rawMetadata: Record<string, unknown>;
  createdAt: string;
  /** True when this row was newly inserted; false when an existing message satisfied the identity constraint. */
  wasInserted: boolean;
}

interface MessageRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  chat_id: string;
  whatsapp_message_id: string;
  remote_jid: string;
  sender_jid: string;
  recipient_jid: string | null;
  sender_contact_id: string | null;
  direction: MessageDirection;
  message_type: MessageType;
  text_content: string | null;
  caption: string | null;
  timestamp: string;
  from_me: boolean;
  revoke_status: 'none' | 'requested' | 'revoke_sent' | 'failed';
  revoke_sent_at: string | null;
  revoke_error: string | null;
  is_historical: boolean;
  status: MessageStatus;
  has_media: boolean;
  media_id: string | null;
  quoted_message_id: string | null;
  is_forwarded: boolean;
  structured_payload: string | null;
  forwarding_score: number | null;
  raw_metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Message bodies are stored at rest as serialized AES-256-GCM envelopes
 * (see src/security/encryption). tryParse() returns null for legacy/plain
 * text so pre-encryption rows keep reading correctly.
 *
 * A decrypt failure here means this specific row was encrypted under a
 * master key that no longer matches the one currently configured -
 * verifyMasterKeyStability() (src/security/encryption/keyStabilityCheck.ts)
 * catches that at boot for the common case, but a row from before that
 * check existed, or from a deliberate ALLOW_MASTER_KEY_CHANGE rotation,
 * can still be unreadable. That plaintext cannot be recovered without the
 * original key - by design, the same as any other lost key. What must not
 * happen is one such row crashing every caller that reads a batch of
 * messages (Promise.all rejects on the first failure) - logged loudly so
 * it is never silently invisible, but the row itself degrades to
 * "content unavailable" rather than taking the whole batch down.
 */
/**
 * Decrypts and parses a structured payload, degrading to null rather than
 * failing the read - same reasoning as decryptTextContent below. A payload
 * that cannot be decrypted or parsed means the message renders as its plain
 * type label, which is exactly what it did before this column existed; it
 * must never take down a whole batch of messages.
 */
async function decryptStructuredPayload(
  businessId: string,
  value: string | null,
): Promise<StructuredMessagePayload | null> {
  if (value === null) return null;
  const envelope = getEncryptionService().tryParse(value);
  if (!envelope) return null;
  try {
    return JSON.parse(await getEncryptionService().decryptField(businessId, envelope)) as StructuredMessagePayload;
  } catch (error) {
    console.error(
      `[whatsappMessageRepository] Failed to decrypt or parse a structured payload for business ${businessId}:`,
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function decryptTextContent(businessId: string, textContent: string | null): Promise<string | null> {
  if (textContent === null) return null;
  const envelope = getEncryptionService().tryParse(textContent);
  if (!envelope) return textContent;
  try {
    return await getEncryptionService().decryptField(businessId, envelope);
  } catch (error) {
    console.error(
      `[whatsappMessageRepository] Failed to decrypt message content for business ${businessId} - ` +
        'the row was likely encrypted under a different MASTER_ENCRYPTION_KEY than is currently configured. ' +
        'Treating as unavailable rather than failing the whole read.',
      error instanceof Error ? error.message : error,
    );
    return null;
  }
}

async function toRecord(row: MessageRow, wasInserted: boolean): Promise<WhatsAppMessageRecord> {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    chatId: row.chat_id,
    whatsappMessageId: row.whatsapp_message_id,
    remoteJid: row.remote_jid,
    senderJid: row.sender_jid,
    recipientJid: row.recipient_jid,
    senderContactId: row.sender_contact_id,
    direction: row.direction,
    messageType: row.message_type,
    textContent: await decryptTextContent(row.business_id, row.text_content),
    caption: row.caption,
    timestamp: row.timestamp,
    fromMe: row.from_me,
    revokeStatus: row.revoke_status ?? 'none',
    revokeSentAt: row.revoke_sent_at ?? null,
    revokeError: row.revoke_error ?? null,
    isHistorical: row.is_historical,
    status: row.status,
    hasMedia: row.has_media,
    mediaId: row.media_id,
    quotedMessageId: row.quoted_message_id,
    isForwarded: row.is_forwarded ?? false,
    structuredPayload: await decryptStructuredPayload(row.business_id, row.structured_payload),
    forwardingScore: row.forwarding_score ?? null,
    rawMetadata: row.raw_metadata,
    createdAt: row.created_at,
    wasInserted,
  };
}

export interface InsertMessageInput {
  businessId: string;
  whatsappAccountId: string;
  chatId: string;
  whatsappMessageId: string;
  remoteJid: string;
  senderJid: string;
  recipientJid?: string | null;
  senderContactId?: string | null;
  direction: MessageDirection;
  messageType: MessageType;
  textContent?: string | null;
  caption?: string | null;
  timestamp: string;
  fromMe: boolean;
  isHistorical: boolean;
  status?: MessageStatus;
  hasMedia?: boolean;
  quotedMessageId?: string | null;
  isForwarded?: boolean;
  structuredPayload?: StructuredMessagePayload | null;
  forwardingScore?: number | null;
  rawMetadata?: Record<string, unknown>;
}

export class WhatsAppMessageRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Inserts the message, relying on the (business_id, whatsapp_account_id,
   * whatsapp_message_id) unique index for duplicate protection. A duplicate
   * insert is not an error: it returns the existing row with wasInserted=false.
   */
  async insert(input: InsertMessageInput): Promise<WhatsAppMessageRecord> {
    const encryptedTextContent =
      input.textContent != null
        ? getEncryptionService()
            .encryptField(input.businessId, input.textContent)
            .then((envelope) => getEncryptionService().serialize(envelope))
        : Promise.resolve(null);

    // A location's coordinates, a shared contact's card and a poll's content
    // are all personal data, so the structured payload gets exactly the same
    // at-rest protection as the message body itself - see migration 1015.
    const encryptedStructuredPayload =
      input.structuredPayload != null
        ? getEncryptionService()
            .encryptField(input.businessId, JSON.stringify(input.structuredPayload))
            .then((envelope) => getEncryptionService().serialize(envelope))
        : Promise.resolve(null);

    const { rows } = await this.db.query<MessageRow>(
      `INSERT INTO whatsapp_messages
         (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid,
          sender_jid, recipient_jid, sender_contact_id, direction, message_type,
          text_content, caption, "timestamp", from_me, is_historical, status, has_media, quoted_message_id, is_forwarded, forwarding_score, structured_payload, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)
       ON CONFLICT (business_id, whatsapp_account_id, whatsapp_message_id) DO NOTHING
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.chatId,
        input.whatsappMessageId,
        input.remoteJid,
        input.senderJid,
        input.recipientJid ?? null,
        input.senderContactId ?? null,
        input.direction,
        input.messageType,
        await encryptedTextContent,
        input.caption ?? null,
        input.timestamp,
        input.fromMe,
        input.isHistorical,
        input.status ?? 'unknown',
        input.hasMedia ?? false,
        input.quotedMessageId ?? null,
        input.isForwarded ?? false,
        input.forwardingScore ?? null,
        await encryptedStructuredPayload,
        JSON.stringify(input.rawMetadata ?? {}),
      ],
    );

    if (rows[0]) return toRecord(rows[0], true);

    const existing = await this.findByWhatsAppId(input.businessId, input.whatsappAccountId, input.whatsappMessageId);
    if (!existing) throw new Error('whatsapp_messages insert conflicted but no existing row found');
    return existing;
  }

  async findByWhatsAppId(
    businessId: string,
    whatsappAccountId: string,
    whatsappMessageId: string,
  ): Promise<WhatsAppMessageRecord | null> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM whatsapp_messages
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND whatsapp_message_id = $3`,
      [businessId, whatsappAccountId, whatsappMessageId],
    );
    return rows[0] ? toRecord(rows[0], false) : null;
  }

  async findById(id: string): Promise<WhatsAppMessageRecord | null> {
    const { rows } = await this.db.query<MessageRow>('SELECT * FROM whatsapp_messages WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0], false) : null;
  }

  /**
   * Tenant-scoped lookup - a message id belonging to another business
   * returns null, identically to a genuinely nonexistent id. Prefer this
   * over the bare findById() for any caller that has a businessId in scope.
   */
  async findByIdForBusiness(id: string, businessId: string): Promise<WhatsAppMessageRecord | null> {
    const { rows } = await this.db.query<MessageRow>(
      'SELECT * FROM whatsapp_messages WHERE id = $1 AND business_id = $2',
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0], false) : null;
  }

  async updateStatus(id: string, status: MessageStatus): Promise<void> {
    await this.db.query('UPDATE whatsapp_messages SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  }

  /**
   * Marks a message as queued for WhatsApp's real delete-for-everyone.
   *
   * Returns false when the row is not in a revocable state - either it is not
   * ours to revoke, or a revoke is already in flight/done. Callers must not
   * enqueue a job when this returns false, which is what keeps a double-click
   * from sending two revoke instructions.
   */
  async markRevokeRequested(id: string, businessId: string, requestedBy: string | null): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE whatsapp_messages
         SET revoke_status = 'requested',
             revoke_requested_at = now(),
             revoke_requested_by = $3,
             revoke_error = NULL,
             updated_at = now()
       WHERE id = $1
         AND business_id = $2
         AND from_me = true
         AND revoke_status IN ('none', 'failed')`,
      [id, businessId, requestedBy],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * WhatsApp accepted the revoke instruction. Deliberately NOT called
   * "markDeleted": we know the instruction was sent, not that every recipient
   * device removed the message.
   */
  async markRevokeSent(id: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_messages
         SET revoke_status = 'revoke_sent', revoke_sent_at = now(), revoke_error = NULL, updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async markRevokeFailed(id: string, reason: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_messages
         SET revoke_status = 'failed', revoke_error = $2, updated_at = now()
       WHERE id = $1`,
      [id, reason.slice(0, 500)],
    );
  }

  /**
   * The sender withdrew this message for everyone (WhatsApp's own
   * "delete for everyone" - a protocolMessage of type REVOKE naming the
   * message being withdrawn).
   *
   * A real soft delete, not a flag: every read in this repository already
   * filters on `deleted_at IS NULL`, so the message leaves the thread, the
   * AI's transcript, the counts and the exports at once - which is what
   * the person who deleted it asked for. The row itself is kept so a
   * replay of the same revoke is a no-op rather than a resurrection.
   *
   * Distinct from revoke_status, which tracks OUR OWN outbound deletions:
   * that records what we asked WhatsApp to do, this records what somebody
   * else actually did.
   *
   * Returns the affected chat's id so the caller can refresh it, or null
   * when the message was never persisted here - which is normal, since a
   * customer can delete something older than our history.
   */
  async markDeletedByPeer(businessId: string, whatsappAccountId: string, whatsappMessageId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ chat_id: string }>(
      `UPDATE whatsapp_messages
         SET deleted_at = now(), updated_at = now()
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND whatsapp_message_id = $3 AND deleted_at IS NULL
       RETURNING chat_id`,
      [businessId, whatsappAccountId, whatsappMessageId],
    );
    return rows[0]?.chat_id ?? null;
  }

  /**
   * The sender edited this message (a protocolMessage of type MESSAGE_EDIT
   * carrying the replacement body).
   *
   * The edit replaces the text in place, the way it does in WhatsApp
   * itself, rather than arriving as a second message - two bubbles saying
   * nearly the same thing would misrepresent a conversation that only ever
   * had one. raw_metadata records only THAT it was edited and when.
   *
   * The previous wording is deliberately not kept. raw_metadata is stored
   * in the clear (text_content is not - see insert above), so keeping the
   * old body there would quietly move a customer's own words out from
   * behind the at-rest encryption that exists specifically to protect
   * them. Knowing a message was changed is the part an operator actually
   * needs; a second plaintext copy of what it used to say is not worth
   * that.
   *
   * Returns the affected chat's id, or null when the message was never
   * persisted here or already reads exactly as the edit would leave it.
   */
  async applyPeerEdit(
    businessId: string,
    whatsappAccountId: string,
    whatsappMessageId: string,
    newText: string,
  ): Promise<string | null> {
    const existing = await this.findByWhatsAppId(businessId, whatsappAccountId, whatsappMessageId);
    if (!existing || existing.textContent === newText) return null;

    const envelope = await getEncryptionService().encryptField(businessId, newText);
    const { rowCount } = await this.db.query(
      `UPDATE whatsapp_messages
         SET text_content = $4,
             raw_metadata = raw_metadata || jsonb_build_object('editedAt', now()::text),
             updated_at = now()
       WHERE id = $1 AND business_id = $2 AND whatsapp_account_id = $3 AND deleted_at IS NULL`,
      [existing.id, businessId, whatsappAccountId, getEncryptionService().serialize(envelope)],
    );
    return (rowCount ?? 0) > 0 ? existing.chatId : null;
  }

  async attachMedia(id: string, mediaId: string): Promise<void> {
    await this.db.query(
      'UPDATE whatsapp_messages SET media_id = $2, has_media = true, updated_at = now() WHERE id = $1',
      [id, mediaId],
    );
  }

  /**
   * "Status comments" feature: this message is a real reply to a real
   * scheduled_statuses row (resolved via WhatsApp's own contextInfo.stanzaId
   * - see whatsappMessagePersistenceService.ts). Stored in rawMetadata
   * rather than a dedicated column, same convention as mentionedJids - a
   * genuinely optional enrichment on the hot message table, not core to
   * the message's own identity.
   */
  async recordStatusReply(id: string, statusId: string): Promise<void> {
    // Deliberately does not touch updated_at - this is a background
    // enrichment discovered after the message was already fully persisted,
    // not a change to the message's own content or delivery state.
    await this.db.query(
      `UPDATE whatsapp_messages SET raw_metadata = raw_metadata || jsonb_build_object('repliedToStatusId', $2::text) WHERE id = $1`,
      [id, statusId],
    );
  }

  /** "Status comments" feature: every real reply to one specific status, most-recent-first. Business-scoped so a status id can never be probed cross-tenant. */
  async listRepliesToStatus(businessId: string, statusId: string, limit = 100): Promise<WhatsAppMessageRecord[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM whatsapp_messages
       WHERE business_id = $1 AND deleted_at IS NULL AND raw_metadata ->> 'repliedToStatusId' = $2
       ORDER BY "timestamp" DESC LIMIT $3`,
      [businessId, statusId, limit],
    );
    return Promise.all(rows.map((row) => toRecord(row, false)));
  }

  /**
   * The provider message keys needed to send WhatsApp a real read receipt
   * for a conversation - inbound messages only (a read receipt for our own
   * outbound send is meaningless) and capped, because WhatsApp only needs
   * the recent unread tail to consider a chat read, not its entire history.
   *
   * Deliberately returns raw identity fields rather than decrypting the
   * messages: a receipt needs ids, never content, so this avoids the
   * decrypt cost entirely.
   */
  async listInboundKeysForReceipt(
    chatId: string,
    businessId: string,
    limit = 50,
  ): Promise<{ whatsappMessageId: string; remoteJid: string; senderJid: string }[]> {
    const { rows } = await this.db.query<{ whatsapp_message_id: string; remote_jid: string; sender_jid: string }>(
      `SELECT whatsapp_message_id, remote_jid, sender_jid FROM whatsapp_messages
        WHERE chat_id = $1 AND business_id = $2 AND from_me = false
        ORDER BY "timestamp" DESC
        LIMIT $3`,
      [chatId, businessId, limit],
    );
    return rows.map((row) => ({
      whatsappMessageId: row.whatsapp_message_id,
      remoteJid: row.remote_jid,
      senderJid: row.sender_jid,
    }));
  }

  async listByChat(chatId: string, limit = 50): Promise<WhatsAppMessageRecord[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM whatsapp_messages WHERE chat_id = $1 AND deleted_at IS NULL
       ORDER BY "timestamp" DESC LIMIT $2`,
      [chatId, limit],
    );
    return Promise.all(rows.map((row) => toRecord(row, false)));
  }

  /**
   * Phase 3B debounce: the authoritative "what has this chat's AI not yet
   * addressed" query, re-run at debounce-fire time rather than trusting
   * anything carried in the BullMQ job payload. Ordered by the real
   * WhatsApp-reported `timestamp` (true conversation order) with
   * `created_at` as a same-value tiebreak; inclusion itself is gated on
   * `created_at` against `sinceMessageId` (this system's own, strictly
   * monotonic insertion order - immune to WhatsApp clock skew or two
   * messages sharing one second-granularity timestamp). `sinceMessageId`
   * null means "everything" (no prior watermark yet). Media messages are
   * deliberately excluded - they reach the AI via the separate, already-
   * correct maybeTriggerMediaAiHandoff path once their real download
   * outcome is known, not this text-debounce window.
   */
  async findUnansweredInboundSince(chatId: string, sinceMessageId: string | null): Promise<WhatsAppMessageRecord[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM whatsapp_messages m
       WHERE m.chat_id = $1 AND m.from_me = false AND m.is_historical = false
         AND m.has_media = false AND m.deleted_at IS NULL
         -- A system notice is not something a customer said. Disappearing
         -- messages being switched on is not a question, and treating it as
         -- an unanswered inbound turn makes the AI reply to it.
         AND m.message_type <> 'system'
         AND (
           $2::uuid IS NULL
           OR m.created_at > (SELECT created_at FROM whatsapp_messages WHERE id = $2::uuid)
         )
       ORDER BY m."timestamp" ASC, m.created_at ASC`,
      [chatId, sinceMessageId],
    );
    return Promise.all(rows.map((row) => toRecord(row, false)));
  }

  /**
   * Activity measure for the group-participation gate (groupParticipationGate.ts):
   * how busy this chat has genuinely been in a trailing window. Uses
   * whatsapp_messages_chat_timestamp_idx (chat_id, timestamp DESC) directly -
   * no new index needed.
   */
  async countRecentActivity(chatId: string, sinceIso: string): Promise<{ messageCount: number; distinctSenders: number }> {
    const { rows } = await this.db.query<{ message_count: string; distinct_senders: string }>(
      `SELECT count(*)::int AS message_count, count(DISTINCT sender_jid)::int AS distinct_senders
       FROM whatsapp_messages
       WHERE chat_id = $1 AND "timestamp" >= $2 AND deleted_at IS NULL`,
      [chatId, sinceIso],
    );
    return { messageCount: Number(rows[0]?.message_count ?? 0), distinctSenders: Number(rows[0]?.distinct_senders ?? 0) };
  }

  /**
   * Business Intelligence Agent: the one bulk, business-wide, real-text
   * fetch this repository has ever needed - every other method here is
   * scoped to one chat or is a count-only aggregate. Deliberately
   * capped (`limit`) to bound both decrypt cost and the analysis
   * prompt's own size; the caller (biExtractionService.ts) is
   * responsible for further capping what actually reaches an LLM.
   * Excludes media-only rows (`text_content IS NOT NULL`) since there
   * is nothing to analyze there - a caption alone still qualifies.
   */
  async listTextForBusinessSince(businessId: string, sinceIso: string, limit = 500): Promise<WhatsAppMessageRecord[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM whatsapp_messages
       WHERE business_id = $1 AND "timestamp" >= $2 AND deleted_at IS NULL
         AND (text_content IS NOT NULL OR caption IS NOT NULL)
       ORDER BY "timestamp" DESC LIMIT $3`,
      [businessId, sinceIso, limit],
    );
    return Promise.all(rows.map((row) => toRecord(row, false)));
  }

  /** Real dashboard aggregate - inbound vs outbound message counts since a real timestamp, never estimated. */
  async countByDirectionSince(
    businessId: string,
    whatsappAccountId: string,
    sinceIso: string,
  ): Promise<{ inbound: number; outbound: number }> {
    const { rows } = await this.db.query<{ direction: MessageDirection; count: string }>(
      `SELECT direction, count(*)::int AS count FROM whatsapp_messages
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND "timestamp" >= $3 AND deleted_at IS NULL
       GROUP BY direction`,
      [businessId, whatsappAccountId, sinceIso],
    );
    const inbound = rows.find((row) => row.direction === 'inbound')?.count ?? '0';
    const outbound = rows.find((row) => row.direction === 'outbound')?.count ?? '0';
    return { inbound: Number(inbound), outbound: Number(outbound) };
  }

  /**
   * Section 68 (Analytics): the same real inbound/outbound signal
   * countByDirectionSince already aggregates, broken out per day instead
   * of collapsed into one period total - the minimum a real trend chart
   * needs. Buckets by UTC calendar day, not the business's own timezone -
   * a known, deliberate simplification for this first real analytics
   * surface (a day boundary a few hours off from the business's actual
   * midnight is still a genuinely useful trend, and this avoids threading
   * a timezone parameter through a query that has never needed one
   * before). Every real day in range gets an entry, including days with
   * zero messages - a caller charting this must never have to guess
   * whether a missing day means "zero" or "not fetched yet".
   */
  async countByDirectionPerDay(
    businessId: string,
    whatsappAccountId: string,
    sinceIso: string,
  ): Promise<{ date: string; inbound: number; outbound: number }[]> {
    const { rows } = await this.db.query<{ day: string; direction: MessageDirection; count: string }>(
      // "timestamp" is timestamptz - date_trunc() truncates in the session's
      // timezone unless told otherwise, which is not necessarily UTC (a real
      // bug found live: this server's own session timezone resolved to
      // America/Blanc-Sablon, not UTC). The doc comment above already
      // promises "buckets by UTC calendar day" and the JS-side gap-fill
      // below already assumes UTC (setUTCHours/getUTCDate) - AT TIME ZONE
      // 'UTC' makes the SQL side actually match that intent instead of
      // silently drifting by the server's local offset for part of every day.
      `SELECT to_char(date_trunc('day', "timestamp" AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, direction, count(*)::int AS count
       FROM whatsapp_messages
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND "timestamp" >= $3 AND deleted_at IS NULL
       GROUP BY day, direction
       ORDER BY day ASC`,
      [businessId, whatsappAccountId, sinceIso],
    );

    const byDay = new Map<string, { inbound: number; outbound: number }>();
    for (const row of rows) {
      const entry = byDay.get(row.day) ?? { inbound: 0, outbound: 0 };
      if (row.direction === 'inbound') entry.inbound = Number(row.count);
      else if (row.direction === 'outbound') entry.outbound = Number(row.count);
      byDay.set(row.day, entry);
    }

    // Fill every real calendar day in [since, today] - never a gap a chart would render as a break in the axis.
    const result: { date: string; inbound: number; outbound: number }[] = [];
    const cursor = new Date(sinceIso);
    cursor.setUTCHours(0, 0, 0, 0);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    while (cursor.getTime() <= today.getTime()) {
      const key = cursor.toISOString().slice(0, 10);
      const entry = byDay.get(key) ?? { inbound: 0, outbound: 0 };
      result.push({ date: key, inbound: entry.inbound, outbound: entry.outbound });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return result;
  }

  /** Real, current count for this business - used by the WhatsApp "Change number" resync UI, never a fabricated progress figure. */
  async countByBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM whatsapp_messages WHERE business_id = $1 AND deleted_at IS NULL`,
      [businessId],
    );
    return Number(rows[0]?.count ?? '0');
  }
}
