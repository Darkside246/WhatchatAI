import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * One person, one chat - even while WhatsApp is moving them between two
 * identities.
 *
 * Reported from a live account: "when i forward anything it splits the chat
 * into two chats, also the same thing happened it seems like text and
 * images go to separate chats" - with a screenshot showing the same contact
 * twice in the list, one row holding the photo and the other the text, one
 * with their name and avatar and the other with neither.
 *
 * The cause is not forwarding. WhatsApp is midway through migrating every
 * account from a phone-number JID to a @lid, and during the move the same
 * person's messages genuinely arrive under either one depending on who sent
 * it and which way it travelled. A chat keyed on the raw JID alone
 * therefore gets opened twice, and from then on half the conversation lands
 * in each.
 *
 * What these pin: a second chat is never opened for somebody who already
 * has one, and nothing is ever merged on a guess.
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

describe('one contact arriving under two WhatsApp identities', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, ACCOUNT_JID);
  });

  const persist = (ingested: IngestedWhatsAppMessage) =>
    whatsappMessagePersistenceService.persist({ businessId, whatsappAccountId: accountId, accountJid: ACCOUNT_JID, ingested });

  const liveChats = async () => {
    const { rows } = await pool.query<{ id: string; chat_jid: string }>(
      'SELECT id, chat_jid FROM whatsapp_chats WHERE business_id = $1 AND deleted_at IS NULL ORDER BY created_at ASC',
      [businessId],
    );
    return rows;
  };

  it('keeps the text and the photo in the same chat when the second one arrives on the other identity', async () => {
    // Exactly the reported sequence: the customer's message on their phone
    // JID, then our forwarded image echoing back on their @lid.
    const first = await persist(ingestedMessage({ messageId: 'WA-TEXT', remoteJid: PHONE_JID, remoteJidAlt: LID_JID }));
    const second = await persist(
      ingestedMessage({
        messageId: 'WA-PHOTO',
        remoteJid: LID_JID,
        jidKind: 'lid',
        remoteJidAlt: PHONE_JID,
        phoneNumber: '+12462606993',
        fromMe: true,
        contentType: 'image',
        textPreview: null,
      }),
    );

    expect(second.chat.id).toBe(first.chat.id);
    expect(await liveChats()).toHaveLength(1);
  });

  it('joins them the other way round too - @lid first, phone JID second', async () => {
    const first = await persist(
      ingestedMessage({ messageId: 'WA-A', remoteJid: LID_JID, jidKind: 'lid', remoteJidAlt: PHONE_JID }),
    );
    const second = await persist(ingestedMessage({ messageId: 'WA-B', remoteJid: PHONE_JID, remoteJidAlt: LID_JID }));

    expect(second.chat.id).toBe(first.chat.id);
    expect(await liveChats()).toHaveLength(1);
  });

  it('still joins them when the message that would split the chat carries no pairing of its own', async () => {
    // The case that actually bites: the pairing is attached to some
    // messages and not others, and the one without it is the one that
    // opens the second row. The mapping recorded off the first message is
    // the only thing that can join them.
    const first = await persist(
      ingestedMessage({ messageId: 'WA-A', remoteJid: LID_JID, jidKind: 'lid', remoteJidAlt: PHONE_JID }),
    );
    const second = await persist(ingestedMessage({ messageId: 'WA-B', remoteJid: PHONE_JID, remoteJidAlt: null }));

    expect(second.chat.id).toBe(first.chat.id);
    expect(await liveChats()).toHaveLength(1);
  });

  it('records the pairing whichever way round WhatsApp states it', async () => {
    // Before this, a pairing given as "phone JID, with the @lid alongside"
    // was thrown away, so there was nothing to join the two identities with
    // later.
    await persist(ingestedMessage({ messageId: 'WA-A', remoteJid: PHONE_JID, remoteJidAlt: LID_JID }));

    const { rows } = await pool.query<{ lid_jid: string; phone_jid: string; phone_number: string }>(
      'SELECT lid_jid, phone_jid, phone_number FROM whatsapp_jid_mappings WHERE business_id = $1',
      [businessId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ lid_jid: LID_JID, phone_jid: PHONE_JID, phone_number: '+12462606993' });
  });

  it('leaves the message itself saying which identity it really came on', async () => {
    // The chat is unified; the message is not rewritten. Anything that has
    // to reason about the migration later still has the truth.
    await persist(ingestedMessage({ messageId: 'WA-A', remoteJid: PHONE_JID, remoteJidAlt: LID_JID }));
    const second = await persist(
      ingestedMessage({ messageId: 'WA-B', remoteJid: LID_JID, jidKind: 'lid', remoteJidAlt: PHONE_JID }),
    );

    const { rows } = await pool.query<{ remote_jid: string }>('SELECT remote_jid FROM whatsapp_messages WHERE id = $1', [
      second.message.id,
    ]);
    expect(rows[0]?.remote_jid).toBe(LID_JID);
  });

  it('never merges two people who simply both messaged', async () => {
    // The failure that would be far worse than the one being fixed: one
    // customer reading another's conversation. Nothing is joined without a
    // pairing WhatsApp itself supplied.
    await persist(ingestedMessage({ messageId: 'WA-A', remoteJid: PHONE_JID }));
    await persist(
      ingestedMessage({ messageId: 'WA-B', remoteJid: '12465551234@s.whatsapp.net', phoneNumber: '+12465551234', pushName: 'Someone else' }),
    );

    expect(await liveChats()).toHaveLength(2);
  });

  it('does not reroute a message that already has a chat of its own', async () => {
    // A business that already has two rows for one contact must not have
    // its live conversation yanked out from under it mid-thread; the split
    // stops growing, and repairing what exists is a separate, visible act.
    const lid = await persist(ingestedMessage({ messageId: 'WA-A', remoteJid: LID_JID, jidKind: 'lid', remoteJidAlt: null }));
    const phone = await persist(ingestedMessage({ messageId: 'WA-B', remoteJid: PHONE_JID, remoteJidAlt: null }));
    expect(phone.chat.id).not.toBe(lid.chat.id);

    const later = await persist(ingestedMessage({ messageId: 'WA-C', remoteJid: PHONE_JID, remoteJidAlt: LID_JID }));
    expect(later.chat.id).toBe(phone.chat.id);
  });

  it('leaves a group chat alone', async () => {
    const group = await persist(
      ingestedMessage({
        messageId: 'WA-G',
        remoteJid: '120363000000000000@g.us',
        jidKind: 'group',
        phoneNumber: null,
        participant: LID_JID,
        participantAlt: PHONE_JID,
      }),
    );
    expect(group.chat.chatJid).toBe('120363000000000000@g.us');
  });
});
