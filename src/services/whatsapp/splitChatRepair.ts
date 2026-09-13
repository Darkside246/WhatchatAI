/**
 * Rejoining a contact whose conversation got split across two WhatsApp
 * identities.
 *
 * WhatsApp is midway through moving every account from a phone-number JID
 * to a @lid, and during the move the same person's messages arrive under
 * either one. Until resolveChatJid (whatsappMessagePersistenceService.ts),
 * that opened a SECOND chat row for somebody who already had one - which
 * showed up as "forwarding splits the chat into two" and "text and images
 * go to separate chats".
 *
 * That fix stops it happening again. It deliberately does not touch rows
 * that already exist: moving a real conversation between rows is
 * destructive, and destructive things should be something a person chose
 * on purpose, having seen first what would happen. This is the half they
 * choose - run from scripts/merge-split-chats.ts, report first, repair
 * only when asked.
 *
 * WHAT IT WILL AND WILL NOT JOIN. Only chats linked by a pairing WhatsApp
 * itself supplied (a whatsapp_jid_mappings row, written from Baileys' own
 * remoteJidAlt). Never two chats that merely share a name, a similar
 * number, or a contact record. Merging two strangers' conversations would
 * be far worse than leaving two rows, so the bar is evidence from WhatsApp
 * or nothing at all.
 */
import { pool } from '../../db/pool.js';
import { withTransaction } from '../../db/transaction.js';

export interface SplitChatPair {
  businessId: string;
  whatsappAccountId: string;
  lidChatId: string;
  lidMessageCount: number;
  lidCreatedAt: string;
  phoneChatId: string;
  phoneMessageCount: number;
  phoneCreatedAt: string;
}

interface SplitRow {
  business_id: string;
  whatsapp_account_id: string;
  lid_chat_id: string;
  lid_message_count: number;
  lid_created_at: Date;
  phone_chat_id: string;
  phone_message_count: number;
  phone_created_at: Date;
}

/**
 * Every pair of live chats a recorded pairing says are one person.
 *
 * Joined through whatsapp_jid_mappings in both directions at once: one
 * chat keyed on the @lid, the other on the phone JID the same mapping row
 * names.
 */
export async function findSplitChats(businessId?: string): Promise<SplitChatPair[]> {
  const { rows } = await pool.query<SplitRow>(
    `SELECT m.business_id,
            m.whatsapp_account_id,
            lid.id              AS lid_chat_id,
            lid.message_count   AS lid_message_count,
            lid.created_at      AS lid_created_at,
            phone.id            AS phone_chat_id,
            phone.message_count AS phone_message_count,
            phone.created_at    AS phone_created_at
       FROM whatsapp_jid_mappings m
       JOIN whatsapp_chats lid
         ON lid.business_id = m.business_id
        AND lid.whatsapp_account_id = m.whatsapp_account_id
        AND lid.chat_jid = m.lid_jid
        AND lid.deleted_at IS NULL
       JOIN whatsapp_chats phone
         ON phone.business_id = m.business_id
        AND phone.whatsapp_account_id = m.whatsapp_account_id
        AND phone.chat_jid = m.phone_jid
        AND phone.deleted_at IS NULL
      WHERE m.phone_jid IS NOT NULL
        AND lid.chat_type = 'individual'
        AND phone.chat_type = 'individual'
        AND ($1::uuid IS NULL OR m.business_id = $1::uuid)
      ORDER BY m.business_id, lid.created_at`,
    [businessId ?? null],
  );

  return rows.map((row) => ({
    businessId: row.business_id,
    whatsappAccountId: row.whatsapp_account_id,
    lidChatId: row.lid_chat_id,
    lidMessageCount: row.lid_message_count,
    lidCreatedAt: new Date(row.lid_created_at).toISOString(),
    phoneChatId: row.phone_chat_id,
    phoneMessageCount: row.phone_message_count,
    phoneCreatedAt: new Date(row.phone_created_at).toISOString(),
  }));
}

/**
 * Every column in the database that points at whatsapp_chats(id), read from
 * the live catalog rather than listed by hand.
 *
 * Sixteen tables reference a chat today and the list grows. A hand-written
 * one would be wrong the first time somebody adds a table, and being wrong
 * here means a food order or a scheduled meeting silently orphaned on a
 * chat row that no longer exists.
 */
export async function chatReferencingColumns(): Promise<{ table: string; column: string }[]> {
  const { rows } = await pool.query<{ table: string; column: string }>(
    `SELECT src.relname AS table, att.attname AS column
       FROM pg_constraint c
       JOIN pg_class src ON src.oid = c.conrelid
       JOIN pg_class tgt ON tgt.oid = c.confrelid
       JOIN unnest(c.conkey) AS k(attnum) ON TRUE
       JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = k.attnum
      WHERE c.contype = 'f' AND tgt.relname = 'whatsapp_chats'
      ORDER BY src.relname, att.attname`,
  );
  return rows;
}

export interface MergeResult {
  keptChatId: string;
  removedChatId: string;
  /** Tables where the surviving chat already had its own row, so the duplicate was dropped rather than moved. */
  droppedDuplicatesIn: string[];
}

/**
 * Moves one chat's whole life into the other and retires it.
 *
 * The OLDER row survives. It is the one carrying the history, the contact
 * link and the name the operator recognises - and it is the one already
 * open on somebody's screen.
 */
export async function mergeSplitChat(
  pair: SplitChatPair,
  references: { table: string; column: string }[],
): Promise<MergeResult> {
  const [keepId, dropId] =
    new Date(pair.lidCreatedAt) <= new Date(pair.phoneCreatedAt)
      ? [pair.lidChatId, pair.phoneChatId]
      : [pair.phoneChatId, pair.lidChatId];

  const droppedDuplicatesIn: string[] = [];

  await withTransaction(async (client) => {
    for (const ref of references) {
      /* Some of these tables hold at most one row per chat (a conversation
         state, a list engagement). Moving the loser's row would collide
         with the survivor's own, so on a unique violation the loser's is
         dropped instead - the survivor's state is the one that has been
         acted on. The savepoint keeps that a per-table decision rather
         than losing the whole merge to one collision. */
      await client.query('SAVEPOINT move_chat_reference');
      try {
        await client.query(`UPDATE ${ref.table} SET ${ref.column} = $1 WHERE ${ref.column} = $2`, [keepId, dropId]);
        await client.query('RELEASE SAVEPOINT move_chat_reference');
      } catch (error) {
        if ((error as { code?: string }).code !== '23505') throw error;
        await client.query('ROLLBACK TO SAVEPOINT move_chat_reference');
        await client.query(`DELETE FROM ${ref.table} WHERE ${ref.column} = $1`, [dropId]);
        await client.query('RELEASE SAVEPOINT move_chat_reference');
        droppedDuplicatesIn.push(ref.table);
      }
    }

    /* Soft-deleted, never DELETEd. If a merge turns out to have joined
       something it should not have, the row and its own identity are still
       there to look at. */
    await client.query('UPDATE whatsapp_chats SET deleted_at = now(), updated_at = now() WHERE id = $1', [dropId]);

    // Recounted from the messages actually in it now, rather than added up
    // from two counters that were each already an approximation.
    await client.query(
      `UPDATE whatsapp_chats c
          SET message_count = sub.count,
              last_message_id = sub.last_id,
              last_message_at = sub.last_at,
              updated_at = now()
         FROM (SELECT count(*) AS count,
                      (SELECT id FROM whatsapp_messages
                        WHERE chat_id = $1 AND deleted_at IS NULL
                        ORDER BY timestamp DESC, created_at DESC LIMIT 1) AS last_id,
                      max(timestamp) AS last_at
                 FROM whatsapp_messages WHERE chat_id = $1 AND deleted_at IS NULL) sub
        WHERE c.id = $1`,
      [keepId],
    );
  });

  return { keptChatId: keepId, removedChatId: dropId, droppedDuplicatesIn };
}
