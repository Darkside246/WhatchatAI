import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { WhatsAppJidMappingRepository } from '../src/repositories/whatsappJidMappingRepository.js';
import { CustomerIdentityRepository } from '../src/repositories/customerIdentityRepository.js';
import { ConversationEventRepository } from '../src/repositories/conversationEventRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppOutboundMessageRepository } from '../src/repositories/whatsappOutboundMessageRepository.js';
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

  it('opportunistically links an individual chat contact to a canonical customer identity', async () => {
    await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage(),
    });

    const { rows: contactRows } = await pool.query<{ id: string }>(
      'SELECT id FROM whatsapp_contacts WHERE whatsapp_jid = $1',
      ['15550003333@s.whatsapp.net'],
    );
    const contactId = contactRows[0]!.id;

    const customerId = await new CustomerIdentityRepository(pool).findCustomerIdByIdentity(
      businessId,
      'whatsapp',
      'whatsapp_contact_id',
      contactId,
    );
    expect(customerId).not.toBeNull();
  });

  it('links repeated messages from the same contact to the same customer, never a new one each time', async () => {
    await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'WA-FIRST' }),
    });
    await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'WA-SECOND' }),
    });

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM customer_identities WHERE business_id = $1', [businessId]);
    expect(rows[0]!.count).toBe('1');
  });

  it('never links a group chat to a customer identity - there is no single individual contact to link', async () => {
    await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({
        messageId: 'WA-GROUP',
        remoteJid: '111222333-4444@g.us',
        jidKind: 'group',
        phoneNumber: null,
      }),
    });

    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM customer_identities WHERE business_id = $1', [businessId]);
    expect(rows[0]!.count).toBe('0');
  });

  it('appends a message_received conversation event for a new, live, inbound message', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage(),
    });

    const events = await new ConversationEventRepository(pool).listByChat(businessId, result.chat.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'message_received',
      payload: { messageId: result.message.id, contentType: 'text' },
    });
  });

  it('does not append a duplicate event for a re-delivered (already-persisted) message', async () => {
    const message = ingestedMessage({ messageId: 'WA-DUPLICATE-EVENT' });
    const first = await whatsappMessagePersistenceService.persist({ businessId, whatsappAccountId: accountId, accountJid, ingested: message });
    await whatsappMessagePersistenceService.persist({ businessId, whatsappAccountId: accountId, accountJid, ingested: message });

    const events = await new ConversationEventRepository(pool).listByChat(businessId, first.chat.id);
    expect(events).toHaveLength(1);
  });

  it('does not append a message_received event for an outbound (fromMe) message', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'WA-OUTBOUND-ECHO', fromMe: true }),
    });

    const events = await new ConversationEventRepository(pool).listByChat(businessId, result.chat.id);
    expect(events).toEqual([]);
  });

  it('does not append a message_received event for historical (non-live) backfill', async () => {
    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested: ingestedMessage({ messageId: 'WA-HISTORICAL-BACKFILL', isLive: false, upsertType: 'append' }),
    });

    const events = await new ConversationEventRepository(pool).listByChat(businessId, result.chat.id);
    expect(events).toEqual([]);
  });

  describe('manual-reply-detected auto-pause', () => {
    it('pauses an AI_ACTIVE chat when a live fromMe message has no matching outbound record - a genuine manual reply typed on the linked device', async () => {
      const result = await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid,
        ingested: ingestedMessage({ messageId: 'WA-MANUAL-REPLY-1', fromMe: true }),
      });

      const chat = await new WhatsAppChatRepository(pool).findById(result.chat.id);
      expect(chat?.aiMode).toBe('HUMAN_TAKEOVER');
      expect(chat?.aiModeSource).toBe('manual_reply_detected');
    });

    it('does not pause when the fromMe echo matches a real outbound record - the AI/dashboard/Operator Mode sent this itself', async () => {
      // Establish the chat first with a real inbound message.
      const inbound = await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid,
        ingested: ingestedMessage({ messageId: 'WA-CUSTOMER-1' }),
      });

      // Simulate this app actually sending a reply: create the outbound row
      // and mark it sent with the WhatsApp message id BEFORE the echo
      // arrives, exactly like WhatsAppOutboundMessageService does.
      const outboundRepo = new WhatsAppOutboundMessageRepository(pool);
      const outbound = await outboundRepo.createIdempotent({
        businessId,
        whatsappAccountId: accountId,
        chatId: inbound.chat.id,
        toJid: '15550003333@s.whatsapp.net',
        idempotencyKey: 'test-app-reply-1',
        messageType: 'text',
        textContent: 'Thanks, on it!',
        requestedBy: 'human',
      });
      await outboundRepo.markSent(outbound.id, 'WA-APP-REPLY-ECHO');

      const echoed = await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid,
        ingested: ingestedMessage({ messageId: 'WA-APP-REPLY-ECHO', fromMe: true }),
      });

      const chat = await new WhatsAppChatRepository(pool).findById(echoed.chat.id);
      expect(chat?.aiMode).toBe('AI_ACTIVE');
      expect(chat?.aiModeSource).not.toBe('manual_reply_detected');
    });

    it('never overrides a chat already in HUMAN_TAKEOVER for a different reason', async () => {
      const first = await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid,
        ingested: ingestedMessage({ messageId: 'WA-CUSTOMER-2' }),
      });

      const chatRepo = new WhatsAppChatRepository(pool);
      await chatRepo.setAiMode(first.chat.id, 'HUMAN_TAKEOVER', 'blocked_keyword');

      await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid,
        ingested: ingestedMessage({ messageId: 'WA-MANUAL-REPLY-2', fromMe: true }),
      });

      const chat = await chatRepo.findById(first.chat.id);
      expect(chat?.aiMode).toBe('HUMAN_TAKEOVER');
      expect(chat?.aiModeSource).toBe('blocked_keyword'); // untouched by the manual-reply detector
    });

    it('does not trigger for historical (non-live) fromMe backfill', async () => {
      const result = await whatsappMessagePersistenceService.persist({
        businessId,
        whatsappAccountId: accountId,
        accountJid,
        ingested: ingestedMessage({ messageId: 'WA-HISTORICAL-OUTBOUND', fromMe: true, isLive: false, upsertType: 'append' }),
      });

      const chat = await new WhatsAppChatRepository(pool).findById(result.chat.id);
      expect(chat?.aiMode).toBe('AI_ACTIVE');
    });
  });
});
