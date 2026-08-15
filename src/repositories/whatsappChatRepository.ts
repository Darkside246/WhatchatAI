import type { Queryable } from './types.js';
import type { WhatsAppJidKind } from '../domain/whatsapp/jid.js';
import type { ChatType } from '../domain/whatsapp/types.js';

export interface WhatsAppChatRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  chatJid: string;
  jidKind: WhatsAppJidKind;
  chatType: ChatType;
  contactId: string | null;
  groupId: string | null;
  name: string | null;
  phoneNumber: string | null;
  isGroup: boolean;
  unreadCount: number;
  messageCount: number;
  lastMessageId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface ChatRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  chat_jid: string;
  jid_kind: WhatsAppJidKind;
  chat_type: ChatType;
  contact_id: string | null;
  group_id: string | null;
  name: string | null;
  phone_number: string | null;
  is_group: boolean;
  unread_count: number;
  message_count: number;
  last_message_id: string | null;
  last_message_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

function toRecord(row: ChatRow): WhatsAppChatRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    chatJid: row.chat_jid,
    jidKind: row.jid_kind,
    chatType: row.chat_type,
    contactId: row.contact_id,
    groupId: row.group_id,
    name: row.name,
    phoneNumber: row.phone_number,
    isGroup: row.is_group,
    unreadCount: row.unread_count,
    messageCount: row.message_count,
    lastMessageId: row.last_message_id,
    lastMessageAt: row.last_message_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

export interface UpsertChatInput {
  businessId: string;
  whatsappAccountId: string;
  chatJid: string;
  jidKind: WhatsAppJidKind;
  chatType: ChatType;
  contactId?: string | null;
  groupId?: string | null;
  name?: string | null;
  phoneNumber?: string | null;
}

export class WhatsAppChatRepository {
  constructor(private readonly db: Queryable) {}

  /** Chat identity is the JID, never the name - a display-name change updates this row in place. */
  async upsertFromWhatsApp(input: UpsertChatInput): Promise<WhatsAppChatRecord> {
    const { rows } = await this.db.query<ChatRow>(
      `INSERT INTO whatsapp_chats
         (business_id, whatsapp_account_id, chat_jid, jid_kind, chat_type,
          contact_id, group_id, name, phone_number, is_group)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (business_id, whatsapp_account_id, chat_jid) WHERE deleted_at IS NULL
       DO UPDATE SET
         contact_id = COALESCE(EXCLUDED.contact_id, whatsapp_chats.contact_id),
         group_id = COALESCE(EXCLUDED.group_id, whatsapp_chats.group_id),
         name = COALESCE(EXCLUDED.name, whatsapp_chats.name),
         phone_number = COALESCE(EXCLUDED.phone_number, whatsapp_chats.phone_number),
         updated_at = now()
       RETURNING *`,
      [
        input.businessId,
        input.whatsappAccountId,
        input.chatJid,
        input.jidKind,
        input.chatType,
        input.contactId ?? null,
        input.groupId ?? null,
        input.name ?? null,
        input.phoneNumber ?? null,
        input.chatType === 'group',
      ],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_chats upsert returned no row');
    return toRecord(row);
  }

  async recordLastMessage(chatId: string, messageId: string, occurredAt: string): Promise<void> {
    await this.db.query(
      `UPDATE whatsapp_chats
       SET last_message_id = $2, last_message_at = $3, message_count = message_count + 1, updated_at = now()
       WHERE id = $1`,
      [chatId, messageId, occurredAt],
    );
  }

  async findByJid(businessId: string, whatsappAccountId: string, chatJid: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>(
      `SELECT * FROM whatsapp_chats
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND chat_jid = $3 AND deleted_at IS NULL`,
      [businessId, whatsappAccountId, chatJid],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async findById(id: string): Promise<WhatsAppChatRecord | null> {
    const { rows } = await this.db.query<ChatRow>('SELECT * FROM whatsapp_chats WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async listByAccount(businessId: string, whatsappAccountId: string): Promise<WhatsAppChatRecord[]> {
    const { rows } = await this.db.query<ChatRow>(
      `SELECT * FROM whatsapp_chats
       WHERE business_id = $1 AND whatsapp_account_id = $2 AND deleted_at IS NULL
       ORDER BY last_message_at DESC NULLS LAST`,
      [businessId, whatsappAccountId],
    );
    return rows.map(toRecord);
  }
}
