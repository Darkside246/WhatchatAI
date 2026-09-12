import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppStatusViewRepository } from '../src/repositories/whatsappStatusViewRepository.js';
import { WhatsAppContactRepository } from '../src/repositories/whatsappContactRepository.js';
import { ScheduledStatusRepository } from '../src/repositories/scheduledStatusRepository.js';
import { listStatusViewers, listStatusReplies } from '../src/services/scheduledStatusService.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppMessageIngestionService } from '../src/services/whatsappMessageIngestionService.js';
import type { WAMessage } from '@whiskeysockets/baileys';
import { createTestAccount, createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

const ACCOUNT_JID = '15550001111@s.whatsapp.net';
const RUTH_JID = '12462508946@s.whatsapp.net';
const STRANGER_JID = '15559998888@s.whatsapp.net';
const PUBLISHED_ID = 'WA-STATUS-PUBLISHED';

const ingestion = new WhatsAppMessageIngestionService();

/**
 * A status is broadcast to an audience and answered privately, so "who saw
 * it" and "who replied" are two different lists - and both were missing.
 * The panel showed the words of a reply with nothing about the person, and
 * showed no audience at all.
 */
describe('the audience for a status', () => {
  let businessId: string;
  let accountId: string;
  let scheduledStatusId: string;
  let views: WhatsAppStatusViewRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, ACCOUNT_JID);
    views = new WhatsAppStatusViewRepository(pool);

    const createdBy = await createTestUser(businessId);
    const statuses = new ScheduledStatusRepository(pool);
    const draft = await statuses.create({
      businessId,
      whatsappAccountId: accountId,
      createdBy,
      statusType: 'text',
      textContent: 'Open until 8 tonight',
      caption: null,
      backgroundColor: null,
      mediaStorageReference: null,
      mediaMimeType: null,
      scheduledAt: new Date().toISOString(),
    });
    scheduledStatusId = draft.id;
    await statuses.recordPublishedMessageId(draft.id, PUBLISHED_ID);
  });

  describe('who watched it', () => {
    it('names them from their contact card, and says when', async () => {
      const contacts = new WhatsAppContactRepository(pool);
      await contacts.upsertFromWhatsApp({
        businessId,
        whatsappAccountId: accountId,
        whatsappJid: RUTH_JID,
        jidKind: 'individual',
        phoneNumber: '+12462508946',
        displayName: 'Ruth Alkins',
      });

      await views.record({
        businessId,
        whatsappAccountId: accountId,
        statusWhatsappId: PUBLISHED_ID,
        viewerJid: RUTH_JID,
        viewedAt: '2026-09-11T18:41:00.000Z',
      });

      const audience = await listStatusViewers(businessId, scheduledStatusId);
      expect(audience).toHaveLength(1);
      expect(audience[0]?.displayName).toBe('Ruth Alkins');
      expect(audience[0]?.phoneNumber).toBe('+12462508946');
      expect(audience[0]?.viewedAt).toBe(new Date('2026-09-11T18:41:00.000Z').toISOString());
    });

    /**
     * Someone can watch a status without being in the address book. Their
     * real JID is a worse answer than a name and a far better one than
     * dropping them from the audience entirely.
     */
    it('still counts someone with no contact card', async () => {
      await views.record({
        businessId,
        whatsappAccountId: accountId,
        statusWhatsappId: PUBLISHED_ID,
        viewerJid: STRANGER_JID,
        viewedAt: new Date().toISOString(),
      });

      const audience = await listStatusViewers(businessId, scheduledStatusId);
      expect(audience).toHaveLength(1);
      expect(audience[0]?.displayName).toBe(STRANGER_JID);
    });

    /**
     * WhatsApp replays receipts after a reconnect. A viewer counted twice
     * would inflate the only engagement number this feature produces, and
     * the second, later timestamp would record our downtime rather than
     * when they actually watched.
     */
    it('counts one person once, however often WhatsApp tells us', async () => {
      const first = { businessId, whatsappAccountId: accountId, statusWhatsappId: PUBLISHED_ID, viewerJid: RUTH_JID, viewedAt: '2026-09-11T18:41:00.000Z' };
      expect(await views.record(first)).toBe(true);
      expect(await views.record({ ...first, viewedAt: '2026-09-11T23:20:00.000Z' })).toBe(false);

      const audience = await listStatusViewers(businessId, scheduledStatusId);
      expect(audience).toHaveLength(1);
      expect(audience[0]?.viewedAt).toBe(new Date('2026-09-11T18:41:00.000Z').toISOString());
    });

    it('is empty for a status that never published', async () => {
      const statuses = new ScheduledStatusRepository(pool);
      const draft = await statuses.create({
        businessId,
        whatsappAccountId: accountId,
        createdBy: await createTestUser(businessId),
        statusType: 'text',
        textContent: 'not sent',
        caption: null,
        backgroundColor: null,
        mediaStorageReference: null,
        mediaMimeType: null,
        scheduledAt: new Date().toISOString(),
      });
      expect(await listStatusViewers(businessId, draft.id)).toEqual([]);
    });

    /** A status id from another tenant must not become a way to read their audience. */
    it('cannot be read across tenants', async () => {
      const otherBusinessId = await createTestBusiness('Someone Else');
      await expect(listStatusViewers(otherBusinessId, scheduledStatusId)).rejects.toThrow();
    });
  });

  describe('who replied', () => {
    it('is named, not left as a raw JID', async () => {
      const contacts = new WhatsAppContactRepository(pool);
      await contacts.upsertFromWhatsApp({
        businessId,
        whatsappAccountId: accountId,
        whatsappJid: RUTH_JID,
        jidKind: 'individual',
        phoneNumber: '+12462508946',
        displayName: 'Ruth Alkins',
      });

      const [ingested] = ingestion.ingestUpsert({
        messages: [
          {
            key: { id: 'WA-REPLY-1', remoteJid: RUTH_JID, fromMe: false },
            message: {
              extendedTextMessage: {
                text: 'are you open now?',
                contextInfo: { stanzaId: PUBLISHED_ID, remoteJid: 'status@broadcast' },
              },
            },
            messageTimestamp: 1_700_000_000,
          } as WAMessage,
        ],
        type: 'notify',
      });

      await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid: ACCOUNT_JID,
        ingested: ingested!,
      });

      const replies = await listStatusReplies(businessId, scheduledStatusId);
      expect(replies).toHaveLength(1);
      expect(replies[0]?.textContent).toBe('are you open now?');
      expect(replies[0]?.senderName).toBe('Ruth Alkins');
      expect(replies[0]?.senderPhoneNumber).toBe('+12462508946');
      // And it still carries the chat, so the panel can open the real
      // conversation to answer in.
      const messages = new WhatsAppMessageRepository(pool);
      expect((await messages.findByIdForBusiness(replies[0]!.id, businessId))?.chatId).toBe(replies[0]?.chatId);
    });
  });
});
