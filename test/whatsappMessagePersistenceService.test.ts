import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { WhatsAppJidMappingRepository } from '../src/repositories/whatsappJidMappingRepository.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

function ingestedMessage(overrides: Partial<IngestedWhatsAppMessage> = {}): IngestedWhatsAppMessage {
  return {
    messageId: 'WA-INGEST-1',
    remoteJid: '15550003333@s.whatsapp.net',
    jidKind: 'individual',
    phoneNumber: '+15550003333',
    participant: null,
    fromMe: false,
    pushName: 'Alex',
    isLive: true,
    upsertType: 'notify',
    messageTimestamp: new Date().toISOString(),
    contentType: 'text',
    documentSubtype: null,
    mimetype: null,
    fileName: null,
    textPreview: 'hi',
    ingestedAt: new Date().toISOString(),
    mediaDescriptor: null,
    ...overrides,
  };
}

describe('WhatsAppMessagePersistenceService', () => {
  let businessId: string;
  let accountId: string;
  const accountJid = '15550001111@s.whatsapp.net';

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);
  });

  it('runs the full transaction: upsert contact, upsert chat, insert message, record last message', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage(),
    });

    expect(result.deduplicated).toBe(false);
    expect(result.chat.chatJid).toBe('15550003333@s.whatsapp.net');
    expect(result.chat.lastMessageId).toBe(result.message.id);

    const { rows: contactRows } = await pool.query(
      'SELECT * FROM whatsapp_contacts WHERE whatsapp_jid = $1',
      ['15550003333@s.whatsapp.net'],
    );
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0].push_name).toBe('Alex');
  });

  it('marks live-ingested messages as not historical, and non-live as historical', async () => {
    const live = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'WA-LIVE', isLive: true, upsertType: 'notify' }),
    });
    expect(live.message.isHistorical).toBe(false);

    const historical = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'WA-HIST', isLive: false, upsertType: 'append' }),
    });
    expect(historical.message.isHistorical).toBe(true);
  });

  it('deduplicates re-delivery of the same WhatsApp message through the whole pipeline', async () => {
    const message = ingestedMessage({ messageId: 'WA-REDELIVERED' });
    const first = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: message,
    });
    const second = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: message,
    });

    expect(first.deduplicated).toBe(false);
    expect(second.deduplicated).toBe(true);
    expect(second.message.id).toBe(first.message.id);
  });

  it('never fabricates a phone number for a @lid conversation with no verified mapping', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({
        messageId: 'WA-LID',
        remoteJid: '234471341175024@lid',
        jidKind: 'lid',
        phoneNumber: null,
      }),
    });

    expect(result.chat.chatJid).toBe('234471341175024@lid');
    expect(result.chat.phoneNumber).toBeNull();
  });

  it('persists a real LID<->phone mapping the moment a message carries one, not just during a contacts/history sync', async () => {
    await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({
        messageId: 'WA-LID-ALT',
        remoteJid: '234471341175024@lid',
        jidKind: 'lid',
        phoneNumber: '+12462451422',
        remoteJidAlt: '12462451422@s.whatsapp.net',
      }),
    });

    const mapping = await new WhatsAppJidMappingRepository(pool).findByLid(businessId, accountId, '234471341175024@lid');
    expect(mapping).not.toBeNull();
    expect(mapping?.phoneNumber).toBe('+12462451422');
    expect(mapping?.phoneJid).toBe('12462451422@s.whatsapp.net');
  });

  it('never writes a mapping when the message carries no alt jid - it never guesses one', async () => {
    await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({
        messageId: 'WA-LID-NO-ALT',
        remoteJid: '999888777@lid',
        jidKind: 'lid',
        phoneNumber: null,
      }),
    });

    const mapping = await new WhatsAppJidMappingRepository(pool).findByLid(businessId, accountId, '999888777@lid');
    expect(mapping).toBeNull();
  });

  it('creates media metadata for media messages without fabricating a download', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({
        messageId: 'WA-VOICE',
        contentType: 'voice_note',
        mimetype: 'audio/ogg; codecs=opus',
        textPreview: null,
      }),
    });

    expect(result.message.hasMedia).toBe(true);
    const { rows } = await pool.query('SELECT * FROM whatsapp_media WHERE message_id = $1', [result.message.id]);
    expect(rows).toHaveLength(1);
    expect(rows[0].media_type).toBe('voice_note');
    expect(rows[0].download_status).toBe('pending');
    expect(rows[0].transcript).toBeNull();
  });
});
