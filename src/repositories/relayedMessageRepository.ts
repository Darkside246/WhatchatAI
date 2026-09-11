import type { Queryable } from './types.js';

export interface RelayedMessageRecord {
  id: string;
  businessId: string;
  chatId: string;
  /** Resolved at read time (joins whatsapp_chats/whatsapp_contacts) so this is never a stale copy of a name that changes later. */
  fromDisplayName: string;
  recipientDescription: string;
  messageText: string;
  whenText: string | null;
  /** The message that caused this entry, when known - lets the board open the conversation at that exact point rather than at its live end. Null for entries recorded before anchoring existed, or whose message has since been deleted. */
  messageId: string | null;
  createdAt: string;
  dismissedAt: string | null;
}

export interface CreateRelayedMessageInput {
  businessId: string;
  chatId: string;
  recipientDescription: string;
  messageText: string;
  whenText?: string | null;
  messageId?: string | null;
}

interface RelayedMessageRow {
  id: string;
  business_id: string;
  chat_id: string;
  from_display_name: string;
  recipient_description: string;
  message_text: string;
  when_text: string | null;
  message_id: string | null;
  created_at: string;
  dismissed_at: string | null;
}

function toRecord(row: RelayedMessageRow): RelayedMessageRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    chatId: row.chat_id,
    fromDisplayName: row.from_display_name,
    recipientDescription: row.recipient_description,
    messageText: row.message_text,
    whenText: row.when_text,
    messageId: row.message_id,
    createdAt: row.created_at,
    dismissedAt: row.dismissed_at,
  };
}

/** The real "from" name resolution - same fallback chain the chat list UI already relies on (whatsapp_chats.name first, since that's usually already the best-available label; the contact's own fields, then a bare phone number, never a raw JID string shown to a human). */
const FROM_DISPLAY_NAME_EXPR = `COALESCE(wc.name, c.display_name, c.push_name, c.short_name, wc.phone_number, wc.chat_jid)`;

export class RelayedMessageRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: CreateRelayedMessageInput): Promise<RelayedMessageRecord> {
    const { rows } = await this.db.query<{ id: string }>(
      `INSERT INTO relayed_messages (business_id, chat_id, recipient_description, message_text, when_text, message_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.businessId, input.chatId, input.recipientDescription, input.messageText, input.whenText ?? null, input.messageId ?? null],
    );
    const id = rows[0]?.id;
    if (!id) throw new Error('Failed to create relayed message');
    const created = await this.findByIdForBusiness(id, input.businessId);
    if (!created) throw new Error('Failed to read back newly created relayed message');
    return created;
  }

  async findByIdForBusiness(id: string, businessId: string): Promise<RelayedMessageRecord | null> {
    const { rows } = await this.db.query<RelayedMessageRow>(
      `SELECT rm.*, ${FROM_DISPLAY_NAME_EXPR} AS from_display_name
       FROM relayed_messages rm
       JOIN whatsapp_chats wc ON wc.id = rm.chat_id
       LEFT JOIN whatsapp_contacts c ON c.id = wc.contact_id
       WHERE rm.id = $1 AND rm.business_id = $2`,
      [id, businessId],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Every currently-undismissed message for this business, newest first - the exact set the dashboard's message board renders. */
  async listOpenForBusiness(businessId: string): Promise<RelayedMessageRecord[]> {
    const { rows } = await this.db.query<RelayedMessageRow>(
      `SELECT rm.*, ${FROM_DISPLAY_NAME_EXPR} AS from_display_name
       FROM relayed_messages rm
       JOIN whatsapp_chats wc ON wc.id = rm.chat_id
       LEFT JOIN whatsapp_contacts c ON c.id = wc.contact_id
       WHERE rm.business_id = $1 AND rm.dismissed_at IS NULL
       ORDER BY rm.created_at DESC`,
      [businessId],
    );
    return rows.map(toRecord);
  }

  /**
   * Only ever removes it from the board (dismissed_at) - never touches
   * whatsapp_chats/whatsapp_messages, so the real WhatsApp conversation
   * this came from is completely unaffected. Conditional on dismissed_at
   * IS NULL so a repeat dismiss is a safe no-op, never resets the
   * timestamp to "now" a second time.
   */
  async dismiss(id: string, businessId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE relayed_messages SET dismissed_at = now() WHERE id = $1 AND business_id = $2 AND dismissed_at IS NULL`,
      [id, businessId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
