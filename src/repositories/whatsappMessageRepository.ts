import type { Queryable } from './types.js';
import type { MessageDirection, MessageStatus, MessageType } from '../domain/whatsapp/types.js';
import { getEncryptionService } from '../security/encryption/index.js';

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

    const { rows } = await this.db.query<MessageRow>(
      `INSERT INTO whatsapp_messages
         (business_id, whatsapp_account_id, chat_id, whatsapp_message_id, remote_jid,
          sender_jid, recipient_jid, sender_contact_id, direction, message_type,
          text_content, caption, "timestamp", from_me, is_historical, status, has_media, quoted_message_id, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
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
}
