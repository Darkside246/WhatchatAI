import type { Queryable } from './types.js';

export interface WhatsAppMessageReactionRecord {
  id: string;
  businessId: string;
  whatsappAccountId: string;
  messageId: string;
  reactorJid: string;
  reaction: string;
  createdAt: string;
  updatedAt: string;
}

interface ReactionRow {
  id: string;
  business_id: string;
  whatsapp_account_id: string;
  message_id: string;
  reactor_jid: string;
  reaction: string;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ReactionRow): WhatsAppMessageReactionRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    messageId: row.message_id,
    reactorJid: row.reactor_jid,
    reaction: row.reaction,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class WhatsAppMessageReactionRepository {
  constructor(private readonly db: Queryable) {}

  /** A reaction must point to a real, already-persisted message (FK-enforced). */
  async upsert(
    businessId: string,
    whatsappAccountId: string,
    messageId: string,
    reactorJid: string,
    reaction: string,
  ): Promise<WhatsAppMessageReactionRecord> {
    const { rows } = await this.db.query<ReactionRow>(
      `INSERT INTO whatsapp_message_reactions (business_id, whatsapp_account_id, message_id, reactor_jid, reaction)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (message_id, reactor_jid)
       DO UPDATE SET reaction = EXCLUDED.reaction, updated_at = now()
       RETURNING *`,
      [businessId, whatsappAccountId, messageId, reactorJid, reaction],
    );
    const row = rows[0];
    if (!row) throw new Error('whatsapp_message_reactions upsert returned no row');
    return toRecord(row);
  }

  /** WhatsApp signals a reaction removal as an event with empty text - the row is deleted, never left with a blank reaction string. */
  async remove(messageId: string, reactorJid: string): Promise<void> {
    await this.db.query('DELETE FROM whatsapp_message_reactions WHERE message_id = $1 AND reactor_jid = $2', [
      messageId,
      reactorJid,
    ]);
  }

  async listByMessage(messageId: string): Promise<WhatsAppMessageReactionRecord[]> {
    const { rows } = await this.db.query<ReactionRow>(
      'SELECT * FROM whatsapp_message_reactions WHERE message_id = $1',
      [messageId],
    );
    return rows.map(toRecord);
  }

  /** Batch read for a message list - one query instead of one per message. */
  async listByMessages(messageIds: string[]): Promise<WhatsAppMessageReactionRecord[]> {
    if (messageIds.length === 0) return [];
    const { rows } = await this.db.query<ReactionRow>(
      'SELECT * FROM whatsapp_message_reactions WHERE message_id = ANY($1)',
      [messageIds],
    );
    return rows.map(toRecord);
  }
}
