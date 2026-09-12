import { beforeEach, describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { pool } from '../src/db/pool.js';
import {
  WhatsAppMessageIngestionService,
  isConversationalMessage,
  type IngestedWhatsAppMessage,
} from '../src/services/whatsappMessageIngestionService.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

const CUSTOMER_JID = '15550003333@s.whatsapp.net';
const ACCOUNT_JID = '15550001111@s.whatsapp.net';

/** Real proto.Message.ProtocolMessage.Type values - see Baileys' own WAProto. */
const REVOKE = 0;
const EPHEMERAL_SETTING = 3;
const HISTORY_SYNC_NOTIFICATION = 5;
const APP_STATE_SYNC_KEY_SHARE = 6;
const PEER_DATA_OPERATION_REQUEST_MESSAGE = 16;
const LID_MIGRATION_MAPPING_SYNC = 22;
const MESSAGE_EDIT = 14;

const ingestion = new WhatsAppMessageIngestionService();

function ingest(id: string, message: WAMessage['message']): IngestedWhatsAppMessage {
  const [ingested] = ingestion.ingestUpsert({
    messages: [{ key: { id, remoteJid: CUSTOMER_JID, fromMe: false }, message, messageTimestamp: 1_700_000_000 } as WAMessage],
    type: 'notify',
  });
  if (!ingested) throw new Error('nothing was ingested');
  return ingested;
}

describe('WhatsApp system messages', () => {
  let businessId: string;
  let accountId: string;
  let messages: WhatsAppMessageRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, ACCOUNT_JID);
    messages = new WhatsAppMessageRepository(pool);
  });

  async function persist(ingested: IngestedWhatsAppMessage) {
    const input = { businessId, whatsappAccountId: accountId, accountJid: ACCOUNT_JID, ingested };
    const event = await whatsappMessagePersistenceService.applySystemEvent(input);
    if (event.consumed) return null;
    return whatsappMessagePersistenceService.persist(input);
  }

  /**
   * WhatsApp's own plumbing. The official client shows none of it to
   * anyone; every one of these used to become a contentless row that the
   * thread rendered as the literal words "System message".
   */
  describe('never reaches a conversation', () => {
    const plumbing = [
      ['a history-sync notification', HISTORY_SYNC_NOTIFICATION],
      ['an app-state key share', APP_STATE_SYNC_KEY_SHARE],
      ['a peer data operation', PEER_DATA_OPERATION_REQUEST_MESSAGE],
      ['a LID migration mapping sync', LID_MIGRATION_MAPPING_SYNC],
    ] as const;

    for (const [name, type] of plumbing) {
      it(name, () => {
        const ingested = ingest(`WA-${type}`, { protocolMessage: { type } });
        expect(ingested.systemEvent).toEqual({ kind: 'plumbing', typeCode: type });
        expect(isConversationalMessage(ingested)).toBe(false);
      });
    }

    it('and an ordinary message still does', () => {
      expect(isConversationalMessage(ingest('WA-TEXT', { conversation: 'hello' }))).toBe(true);
    });
  });

  /**
   * The one protocol subtype that IS a conversation event a person should
   * see, and it now says what happened rather than "System message".
   */
  describe('says what actually happened', () => {
    it('when disappearing messages are turned on', async () => {
      const ingested = ingest('WA-EPH-ON', { protocolMessage: { type: EPHEMERAL_SETTING, ephemeralExpiration: 604_800 } });
      expect(isConversationalMessage(ingested)).toBe(true);
      expect(ingested.fullText).toBe('Disappearing messages turned on - 7 days');

      const result = await persist(ingested);
      expect(result?.message.textContent).toBe('Disappearing messages turned on - 7 days');
    });

    it('when they are turned off', () => {
      expect(ingest('WA-EPH-OFF', { protocolMessage: { type: EPHEMERAL_SETTING, ephemeralExpiration: 0 } }).fullText).toBe(
        'Disappearing messages turned off',
      );
    });
  });

  describe('a message the sender deleted for everyone', () => {
    it('leaves the conversation, instead of being joined by a blank bubble', async () => {
      const original = await persist(ingest('WA-ORIGINAL', { conversation: 'I should not have sent that' }));
      expect(original).not.toBeNull();

      const revoke = ingest('WA-REVOKE', { protocolMessage: { type: REVOKE, key: { id: 'WA-ORIGINAL', remoteJid: CUSTOMER_JID } } });
      expect(await persist(revoke)).toBeNull();

      const thread = await messages.listByChat(original!.chat.id);
      expect(thread.map((message) => message.textContent)).not.toContain('I should not have sent that');
      // And nothing took its place - the deletion is not itself a message.
      expect(thread).toHaveLength(0);
    });

    /**
     * Normal, not an error: a customer can delete something older than any
     * history we hold. WhatsApp's own client shows nothing in that case
     * either, so neither do we.
     */
    it('that we never held is consumed silently', async () => {
      const revoke = ingest('WA-REVOKE-2', { protocolMessage: { type: REVOKE, key: { id: 'NEVER-SEEN', remoteJid: CUSTOMER_JID } } });
      expect(await persist(revoke)).toBeNull();
      const { rows } = await pool.query('SELECT 1 FROM whatsapp_messages');
      expect(rows).toHaveLength(0);
    });
  });

  describe('a message the sender edited', () => {
    it('is rewritten in place, not answered with a second bubble', async () => {
      const original = await persist(ingest('WA-EDITABLE', { conversation: 'meet me at 4' }));

      const edit = ingest('WA-EDIT', {
        protocolMessage: {
          type: MESSAGE_EDIT,
          key: { id: 'WA-EDITABLE', remoteJid: CUSTOMER_JID },
          editedMessage: { conversation: 'meet me at 5' },
        },
      });
      expect(await persist(edit)).toBeNull();

      const thread = await messages.listByChat(original!.chat.id);
      expect(thread).toHaveLength(1);
      expect(thread[0]?.textContent).toBe('meet me at 5');
      // The fact of the edit is recorded; the old wording deliberately is
      // not, because raw_metadata is not encrypted and the body is.
      expect(thread[0]?.rawMetadata.editedAt).toBeTruthy();
      expect(JSON.stringify(thread[0]?.rawMetadata)).not.toContain('meet me at 4');
    });
  });
});

/**
 * A system notice now carries real text, which is the point - but text on
 * the customer's side of a chat is exactly what makes the AI answer. These
 * two guards are what stop "Disappearing messages turned on - 7 days" from
 * becoming a question the agent replies to.
 */
describe('a system notice is never a turn the AI answers', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, ACCOUNT_JID);
  });

  it('is not an unanswered inbound message', async () => {
    const input = (ingested: IngestedWhatsAppMessage) => ({
      businessId,
      whatsappAccountId: accountId,
      accountJid: ACCOUNT_JID,
      ingested,
    });

    const asked = await whatsappMessagePersistenceService.persist(input(ingest('WA-ASK', { conversation: 'are you open?' })));
    await whatsappMessagePersistenceService.persist(
      input(ingest('WA-EPH', { protocolMessage: { type: EPHEMERAL_SETTING, ephemeralExpiration: 604_800 } })),
    );

    const messages = new WhatsAppMessageRepository(pool);
    const unanswered = await messages.findUnansweredInboundSince(asked.chat.id, null);
    expect(unanswered.map((message) => message.whatsappMessageId)).toEqual(['WA-ASK']);
  });
});
