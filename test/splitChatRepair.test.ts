import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { chatReferencingColumns, findSplitChats, mergeSplitChat } from '../src/services/whatsapp/splitChatRepair.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Putting back together a conversation that was already split.
 *
 * The persistence fix stops new splits; it deliberately leaves existing
 * ones alone, because moving a real conversation between rows is
 * destructive and should be something a person chose on purpose. This is
 * that choice, and these are the things it must get right before anybody
 * points it at a live database: nothing orphaned, nothing lost, and
 * nothing joined on a guess.
 */

const ACCOUNT_JID = '15550001111@s.whatsapp.net';
const PHONE_JID = '12462606993@s.whatsapp.net';
const LID_JID = '198765432109876@lid';

function ingestedMessage(overrides: Partial<IngestedWhatsAppMessage> = {}): IngestedWhatsAppMessage {
  return {
    messageId: 'WA-1',
    remoteJid: PHONE_JID,
    jidKind: 'individual',
    phoneNumber: '+12462606993',
    participant: null,
    fromMe: false,
    pushName: 'Corey',
    isLive: true,
    upsertType: 'notify',
    messageTimestamp: new Date().toISOString(),
    contentType: 'text',
    documentSubtype: null,
    mimetype: null,
    fileName: null,
    textPreview: 'yow',
    ingestedAt: new Date().toISOString(),
    mediaDescriptor: null,
    isForwarded: false,
    forwardingScore: null,
    structuredPayload: null,
    ...overrides,
  };
}

describe('repairing a chat that is already split in two', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, ACCOUNT_JID);
  });

  const persist = (ingested: IngestedWhatsAppMessage) =>
    whatsappMessagePersistenceService.persist({ businessId, whatsappAccountId: accountId, accountJid: ACCOUNT_JID, ingested });

  /**
   * Builds the exact damage a live database already carries: two chats for
   * one person, and only afterwards the pairing that proves they are one.
   * (That ordering is the real one - the mapping is written by whichever
   * message first happens to carry it.)
   */
  async function buildSplit(): Promise<{ lidChatId: string; phoneChatId: string }> {
    const lid = await persist(ingestedMessage({ messageId: 'WA-LID', remoteJid: LID_JID, jidKind: 'lid', remoteJidAlt: null }));
    const phone = await persist(ingestedMessage({ messageId: 'WA-PHONE', remoteJid: PHONE_JID, remoteJidAlt: null }));
    expect(phone.chat.id).not.toBe(lid.chat.id);

    await pool.query(
      `INSERT INTO whatsapp_jid_mappings (business_id, whatsapp_account_id, lid_jid, phone_jid, phone_number, source, confidence)
       VALUES ($1, $2, $3, $4, $5, 'baileys_alt_jid', 'high')`,
      [businessId, accountId, LID_JID, PHONE_JID, '+12462606993'],
    );

    return { lidChatId: lid.chat.id, phoneChatId: phone.chat.id };
  }

  it('finds the split, and says which two rows it is', async () => {
    const { lidChatId, phoneChatId } = await buildSplit();
    const splits = await findSplitChats(businessId);
    expect(splits).toHaveLength(1);
    expect(splits[0]).toMatchObject({ lidChatId, phoneChatId });
  });

  it('finds nothing when a contact has only ever had one chat', async () => {
    await persist(ingestedMessage({ messageId: 'WA-A', remoteJid: PHONE_JID, remoteJidAlt: LID_JID }));
    expect(await findSplitChats(businessId)).toHaveLength(0);
  });

  it('moves every message into the older chat and retires the newer one', async () => {
    const { lidChatId, phoneChatId } = await buildSplit();
    const result = await mergeSplitChat((await findSplitChats(businessId))[0]!, await chatReferencingColumns());

    // The @lid chat was created first, so it is the one that survives.
    expect(result.keptChatId).toBe(lidChatId);
    expect(result.removedChatId).toBe(phoneChatId);

    const { rows } = await pool.query<{ chat_id: string }>(
      'SELECT chat_id FROM whatsapp_messages WHERE business_id = $1',
      [businessId],
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) expect(row.chat_id).toBe(lidChatId);
  });

  it('leaves exactly one chat standing, and soft-deletes rather than destroys the other', async () => {
    const { phoneChatId } = await buildSplit();
    await mergeSplitChat((await findSplitChats(businessId))[0]!, await chatReferencingColumns());

    const { rows: live } = await pool.query('SELECT id FROM whatsapp_chats WHERE business_id = $1 AND deleted_at IS NULL', [businessId]);
    expect(live).toHaveLength(1);

    // Still there to look at, if a merge ever turns out to have been wrong.
    const { rows: retired } = await pool.query('SELECT id FROM whatsapp_chats WHERE id = $1', [phoneChatId]);
    expect(retired).toHaveLength(1);
  });

  it('recounts the survivor rather than trusting either old counter', async () => {
    const { lidChatId } = await buildSplit();
    await mergeSplitChat((await findSplitChats(businessId))[0]!, await chatReferencingColumns());

    const { rows } = await pool.query<{ message_count: number; last_message_id: string | null }>(
      'SELECT message_count, last_message_id FROM whatsapp_chats WHERE id = $1',
      [lidChatId],
    );
    expect(rows[0]?.message_count).toBe(2);
    expect(rows[0]?.last_message_id).not.toBeNull();
  });

  it('reads the tables to move from the live catalog, so a new one is never missed', async () => {
    // A hand-written list would be wrong the first time somebody adds a
    // table, and being wrong here orphans a real record on a chat row that
    // no longer exists.
    const references = await chatReferencingColumns();
    expect(references.length).toBeGreaterThanOrEqual(10);
    expect(references).toContainEqual({ table: 'whatsapp_messages', column: 'chat_id' });
  });

  it('leaves nothing at all pointing at the retired chat', async () => {
    const { phoneChatId } = await buildSplit();
    const references = await chatReferencingColumns();
    await mergeSplitChat((await findSplitChats(businessId))[0]!, references);

    for (const ref of references) {
      const { rows } = await pool.query(`SELECT 1 FROM ${ref.table} WHERE ${ref.column} = $1 LIMIT 1`, [phoneChatId]);
      expect(rows, `${ref.table}.${ref.column} still points at the retired chat`).toHaveLength(0);
    }
  });

  it('is finished after one pass', async () => {
    await buildSplit();
    await mergeSplitChat((await findSplitChats(businessId))[0]!, await chatReferencingColumns());
    expect(await findSplitChats(businessId)).toHaveLength(0);
  });

  it('never joins two chats that no pairing links', async () => {
    // The failure that would be far worse than the one being repaired: one
    // customer reading another's conversation.
    await persist(ingestedMessage({ messageId: 'WA-A', remoteJid: PHONE_JID, remoteJidAlt: null }));
    await persist(ingestedMessage({ messageId: 'WA-B', remoteJid: '12465551234@s.whatsapp.net', phoneNumber: '+12465551234' }));
    expect(await findSplitChats(businessId)).toHaveLength(0);
  });

  it('keeps one business repair out of another', async () => {
    await buildSplit();
    const otherBusinessId = await createTestBusiness();
    expect(await findSplitChats(otherBusinessId)).toHaveLength(0);
  });
});
