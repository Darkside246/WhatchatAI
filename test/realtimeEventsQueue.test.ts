import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { WhatsAppCallRepository } from '../src/repositories/whatsappCallRepository.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { enqueueMessageStatus, enqueueCallEvent, realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { realtimeEventsWorker, incomingMessagesWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import { incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { subscribeToRealtimeEvents, type RealtimeEvent } from '../src/realtime/pubsub.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('realtime_events queue (real Redis + real worker + real Postgres)', () => {
  let businessId: string;
  let accountId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);
  });

  afterAll(async () => {
    await realtimeEventsWorker.close();
    await incomingMessagesWorker.close();
    await realtimeEventsQueue.close();
    await incomingMessagesQueue.close();
  });

  it('updates a real message status and publishes a real-time event', async () => {
    const chatRepository = new WhatsAppChatRepository(pool);
    const messageRepository = new WhatsAppMessageRepository(pool);

    const chat = await chatRepository.upsertFromWhatsApp({
      businessId,
      whatsappAccountId: accountId,
      chatJid: '15550001111@s.whatsapp.net',
      jidKind: 'individual',
      chatType: 'individual',
    });
    const message = await messageRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      chatId: chat.id,
      whatsappMessageId: 'STATUS-MSG-1',
      remoteJid: chat.chatJid,
      senderJid: accountId,
      direction: 'outbound',
      messageType: 'text',
      textContent: 'delivery receipt test',
      timestamp: new Date().toISOString(),
      fromMe: true,
      isHistorical: false,
      status: 'sent',
    });

    const events: RealtimeEvent[] = [];
    const unsubscribe = subscribeToRealtimeEvents((event) => events.push(event));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for status update')), 10_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'message-status') return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    await enqueueMessageStatus({
      businessId,
      whatsappAccountId: accountId,
      whatsappMessageId: 'STATUS-MSG-1',
      status: 'delivered',
    });
    await completion;

    const updated = await messageRepository.findById(message.id);
    expect(updated?.status).toBe('delivered');

    await new Promise((resolve) => setTimeout(resolve, 200));
    unsubscribe();
    expect(events).toContainEqual({
      type: 'message.status',
      businessId,
      chatId: chat.id,
      messageId: message.id,
      status: 'delivered',
    });
  });

  it('upserts a real call row from an offer then an accept event, computing real duration', async () => {
    const callRepository = new WhatsAppCallRepository(pool);
    const callId = `CALL-${Date.now()}`;
    const remoteJid = '15550002222@s.whatsapp.net';

    const offerDate = new Date('2026-01-01T00:00:00.000Z');
    const acceptDate = new Date('2026-01-01T00:00:30.000Z');

    const offerCompletion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out on offer')), 10_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'call-event' || (job.data as { event: { status: string } }).event.status !== 'offer') return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    await enqueueCallEvent({
      businessId,
      whatsappAccountId: accountId,
      event: { chatId: remoteJid, from: remoteJid, id: callId, date: offerDate, isVideo: false, status: 'offer', offline: false },
    });
    await offerCompletion;

    const afterOffer = await callRepository.findByCallId(businessId, accountId, callId);
    expect(afterOffer?.status).toBe('offer');
    expect(afterOffer?.startedAt).not.toBeNull();

    const acceptCompletion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out on accept')), 10_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'call-event' || (job.data as { event: { status: string } }).event.status !== 'accept') return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    await enqueueCallEvent({
      businessId,
      whatsappAccountId: accountId,
      event: { chatId: remoteJid, from: remoteJid, id: callId, date: acceptDate, isVideo: false, status: 'accept', offline: false },
    });
    await acceptCompletion;

    const final = await callRepository.findByCallId(businessId, accountId, callId);
    expect(final?.status).toBe('accepted');
    expect(final?.durationSeconds).toBe(30);
    expect(final?.remotePhoneNumber).toBe('+15550002222');
  });
});
