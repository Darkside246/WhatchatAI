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
  raw_metadata: Record<string, unknown>;
  created_at: string;
}

/**
 * Message bodies are stored at rest as serialized AES-256-GCM envelopes
 * (see src/security/encryption). tryParse() returns null for legacy/plain
 * text so pre-encryption rows keep reading correctly.
 */
async function decryptTextContent(businessId: string, textContent: string | null): Promise<string | null> {
  if (textContent === null) return null;
  const envelope = getEncryptionService().tryParse(textContent);
  if (!envelope) return textContent;
  return getEncryptionService().decryptField(businessId, envelope);
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
          text_content, caption, "timestamp", from_me, is_historical, status, has_media, raw_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
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

  async listByChat(chatId: string, limit = 50): Promise<WhatsAppMessageRecord[]> {
    const { rows } = await this.db.query<MessageRow>(
      `SELECT * FROM whatsapp_messages WHERE chat_id = $1 AND deleted_at IS NULL
       ORDER BY "timestamp" DESC LIMIT $2`,
      [chatId, limit],
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
}
