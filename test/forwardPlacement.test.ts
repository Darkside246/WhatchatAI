import { beforeEach, describe, expect, it } from 'vitest';
import type { WAMessage } from '@whiskeysockets/baileys';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppMessageIngestionService } from '../src/services/whatsappMessageIngestionService.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Where a forwarded message lands in the thread.
 *
 * Reported: "when i forward something the image goes but it goes not to the
 * bottom of the chat but to a random location in the chat starting the chat
 * from like a day before or hours before."
 *
 * Reading the code found no mechanism for it, which is exactly the point at
 * which reading stops being worth anything. This drives the real pipeline -
 * ingestion, classification, persistence, and the query the thread actually
 * renders - with a day-old original and a forward sent now, and asserts
 * where the forward ends up.
 *
 * Either it reproduces, or the server is ruled out and the browser and
 * WhatsApp itself are what remain. Both outcomes are worth more than
 * another theory.
 */

const CUSTOMER_JID = '15550006666@s.whatsapp.net';
const ACCOUNT_JID = '15550001111@s.whatsapp.net';

/** What Baileys emits for a message WE sent - note the type. */
function ourOwnSend(id: string, message: Record<string, unknown>, sentAtSeconds: number): WAMessage {
  return {
    key: { id, remoteJid: CUSTOMER_JID, fromMe: true },
    message,
    messageTimestamp: sentAtSeconds,
  } as unknown as WAMessage;
}

function theirMessage(id: string, message: Record<string, unknown>, sentAtSeconds: number): WAMessage {
  return {
    key: { id, remoteJid: CUSTOMER_JID, fromMe: false },
    message,
    messageTimestamp: sentAtSeconds,
  } as unknown as WAMessage;
}

const SECONDS = 1;
const DAY = 86_400 * SECONDS;

describe('a forwarded image, end to end', () => {
  let businessId: string;
  let accountId: string;
  let chatId: string;
  const ingestion = new WhatsAppMessageIngestionService();
  let messages: WhatsAppMessageRepository;

  /** The one detail that matters: our own sends arrive as 'append', not 'notify'. */
  async function arrive(envelope: WAMessage, type: 'notify' | 'append') {
    const [ingested] = ingestion.ingestUpsert({ messages: [envelope], type });
    if (!ingested) throw new Error('nothing was ingested');
    return whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid: ACCOUNT_JID,
      ingested,
    });
  }

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, ACCOUNT_JID);
    messages = new WhatsAppMessageRepository(pool);

    const chat = await new WhatsAppChatRepository(pool).upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: CUSTOMER_JID,
      jidKind: 'individual',
      chatType: 'individual',
    });
    chatId = chat.id;
  });

  it('lands at the bottom of the thread, not back where the original was', async () => {
    const now = Math.floor(Date.UTC(2026, 8, 13, 18, 0, 0) / 1000);

    // A day-old photo, then a day of ordinary conversation, then the
    // forward of that photo sent now.
    await arrive(theirMessage('old-photo', { imageMessage: { mimetype: 'image/jpeg', caption: 'the flyer' } }, now - DAY), 'notify');
    await arrive(theirMessage('yesterday-chat', { conversation: 'see it?' }, now - DAY + 60), 'notify');
    await arrive(theirMessage('this-morning', { conversation: 'morning' }, now - 3600), 'notify');
    await arrive(ourOwnSend('the-forward', { imageMessage: { mimetype: 'image/jpeg', caption: 'the flyer' } }, now), 'append');

    // listByChat is newest-first; the browser reverses it to render.
    const thread = await messages.listByChat(chatId);
    expect(thread[0]?.whatsappMessageId).toBe('the-forward');
  });

  it('is stored at the time it was sent, not the time the original was', async () => {
    const now = Math.floor(Date.UTC(2026, 8, 13, 18, 0, 0) / 1000);

    await arrive(theirMessage('old-photo', { imageMessage: { mimetype: 'image/jpeg' } }, now - DAY), 'notify');
    await arrive(ourOwnSend('the-forward', { imageMessage: { mimetype: 'image/jpeg' } }, now), 'append');

    const [newest] = await messages.listByChat(chatId);
    expect(new Date(newest!.timestamp).getTime()).toBe(now * 1000);
  });

  it('still lands last when WhatsApp sends no timestamp at all', async () => {
    // The one path that could produce a wrong position from this side: a
    // missing messageTimestamp falls back to the ingestion clock, which is
    // now - so it must still sort last, never at the epoch.
    const now = Math.floor(Date.UTC(2026, 8, 13, 18, 0, 0) / 1000);
    await arrive(theirMessage('old-photo', { imageMessage: { mimetype: 'image/jpeg' } }, now - DAY), 'notify');

    const envelope = ourOwnSend('no-timestamp', { imageMessage: { mimetype: 'image/jpeg' } }, 0);
    await arrive(envelope, 'append');

    const [newest] = await messages.listByChat(chatId);
    expect(newest?.whatsappMessageId).toBe('no-timestamp');
  });

  it('moves the conversation to the top of the list, with the forward as its preview', async () => {
    const now = Math.floor(Date.UTC(2026, 8, 13, 18, 0, 0) / 1000);
    await arrive(theirMessage('old-photo', { imageMessage: { mimetype: 'image/jpeg' } }, now - DAY), 'notify');
    await arrive(ourOwnSend('the-forward', { imageMessage: { mimetype: 'image/jpeg', caption: 'here' } }, now), 'append');

    const chat = await new WhatsAppChatRepository(pool).findByIdForBusiness(chatId, businessId);
    expect(new Date(chat!.lastMessageAt!).getTime()).toBe(now * 1000);
  });

  it('marks our own send as outbound even though it arrives as history', async () => {
    // Baileys re-delivers a message we sent through messages.upsert with
    // type 'append', which is the same type a history sync uses. That is
    // why every outbound message in the thread carries the "history" label
    // - worth pinning, because it is the one visible oddity around a
    // forward and it is NOT a position bug.
    const now = Math.floor(Date.UTC(2026, 8, 13, 18, 0, 0) / 1000);
    const result = await arrive(ourOwnSend('the-forward', { conversation: 'passed on' }, now), 'append');

    expect(result.message.direction).toBe('outbound');
    expect(result.message.isHistorical).toBe(true);
  });
});
