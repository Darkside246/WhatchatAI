import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppStatusRepository } from '../src/repositories/whatsappStatusRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { realtimeEventsWorker, incomingMessagesWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';

describe('status@broadcast routing (real Postgres, real BullMQ worker)', () => {
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

  it('persists a status update to whatsapp_statuses, never to whatsapp_messages', async () => {
    const statusRepository = new WhatsAppStatusRepository(pool);
    const publisherJid = '15550007777@s.whatsapp.net';
    const statusId = `STATUS-${Date.now()}`;
    const postedAt = new Date();

    const ingested: IngestedWhatsAppMessage = {
      messageId: statusId,
      remoteJid: 'status@broadcast',
      jidKind: 'broadcast',
      phoneNumber: null,
      participant: publisherJid,
      fromMe: false,
      pushName: 'A Friend',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: postedAt.toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: 'On vacation this week!',
      ingestedAt: postedAt.toISOString(),
      mediaDescriptor: null,
    };

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for status-update job')), 10_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'status-update') return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    await realtimeEventsQueue.add('status-update', { businessId, whatsappAccountId: accountId, ingested });
    await completion;

    const statuses = await statusRepository.listByAccount(businessId, accountId);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]?.statusId).toBe(statusId);
    expect(statuses[0]?.publisherJid).toBe(publisherJid);
    expect(statuses[0]?.statusType).toBe('text');
    expect(statuses[0]?.textContent).toBe('On vacation this week!');

    // WhatsApp statuses always expire ~24h after posting.
    const expiresAt = new Date(statuses[0]!.expiresAt!).getTime();
    const expectedExpiry = postedAt.getTime() + 24 * 60 * 60 * 1000;
    expect(Math.abs(expiresAt - expectedExpiry)).toBeLessThan(2000);

    // Never leaked into the regular message/chat pipeline.
    const messageRepository = new WhatsAppMessageRepository(pool);
    const asMessage = await messageRepository.findByWhatsAppId(businessId, accountId, statusId);
    expect(asMessage).toBeNull();
  });

  it('maps image/video/audio content types to their real status_type, and unknown otherwise', async () => {
    const statusRepository = new WhatsAppStatusRepository(pool);

    async function postStatus(contentType: IngestedWhatsAppMessage['contentType'], statusId: string): Promise<void> {
      const ingested: IngestedWhatsAppMessage = {
        messageId: statusId,
        remoteJid: 'status@broadcast',
        jidKind: 'broadcast',
        phoneNumber: null,
        participant: '15550008888@s.whatsapp.net',
        fromMe: false,
        pushName: null,
        isLive: true,
        upsertType: 'notify',
        messageTimestamp: new Date().toISOString(),
        contentType,
        documentSubtype: null,
        mimetype: contentType === 'image' ? 'image/jpeg' : null,
        fileName: null,
        textPreview: null,
        ingestedAt: new Date().toISOString(),
        mediaDescriptor: null,
      };
      const completion = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out on ${statusId}`)), 10_000);
        realtimeEventsWorker.on('completed', function onCompleted(job) {
          if (job.name !== 'status-update' || (job.data as { ingested: { messageId: string } }).ingested.messageId !== statusId)
            return;
          clearTimeout(timeout);
          realtimeEventsWorker.off('completed', onCompleted);
          resolve();
        });
      });
      await realtimeEventsQueue.add('status-update', { businessId, whatsappAccountId: accountId, ingested });
      await completion;
    }

    await postStatus('image', 'STATUS-IMG');
    await postStatus('voice_note', 'STATUS-VOICE');
    await postStatus('poll', 'STATUS-POLL');

    const statuses = await statusRepository.listByAccount(businessId, accountId);
    const byId = new Map(statuses.map((status) => [status.statusId, status]));
    expect(byId.get('STATUS-IMG')?.statusType).toBe('image');
    expect(byId.get('STATUS-VOICE')?.statusType).toBe('audio');
    expect(byId.get('STATUS-POLL')?.statusType).toBe('unknown');
  });
});
