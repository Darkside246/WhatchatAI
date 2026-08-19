import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { enqueueIncomingMessage, incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { incomingMessagesWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';

describe('incoming_messages BullMQ pipeline (real Redis queue + real worker + real Postgres)', () => {
  let businessId: string;
  let accountId: string;
  let accountJid: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountJid = '15550001111@s.whatsapp.net';
    accountId = await createTestAccount(businessId, accountJid);
  });

  afterAll(async () => {
    await incomingMessagesWorker.close();
    await incomingMessagesQueue.close();
  });

  it('processes a queued message end-to-end into a real, encrypted-at-rest Postgres row', async () => {
    const messageId = `WORKER-MSG-${Date.now()}`;
    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: '15550002222@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550002222',
      participant: null,
      fromMe: false,
      pushName: 'Queue Test Contact',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'text',
      documentSubtype: null,
      mimetype: null,
      fileName: null,
      textPreview: 'Message delivered through the real BullMQ pipeline',
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for worker to process job')), 10_000);
      incomingMessagesWorker.on('completed', function onCompleted(job) {
        if (job.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('completed', onCompleted);
        resolve();
      });
      incomingMessagesWorker.on('failed', function onFailed(job, error) {
        if (job?.data.message.messageId !== messageId) return;
        clearTimeout(timeout);
        incomingMessagesWorker.off('failed', onFailed);
        reject(error);
      });
    });

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid, message: ingested });
    await completion;

    const messageRepository = new WhatsAppMessageRepository(pool);
    const persisted = await messageRepository.findByWhatsAppId(businessId, accountId, messageId);
    expect(persisted).not.toBeNull();
    expect(persisted?.textContent).toBe(ingested.textPreview);

    const chatRepository = new WhatsAppChatRepository(pool);
    const chat = await chatRepository.findByJid(businessId, accountId, ingested.remoteJid);
    expect(chat?.id).toBe(persisted?.chatId);

    // Confirm the speed-layer write really is encrypted at rest, same as the direct-repository path.
    const { rows } = await pool.query<{ text_content: string }>(
      'SELECT text_content FROM whatsapp_messages WHERE id = $1',
      [persisted!.id],
    );
    expect(rows[0].text_content).not.toBe(ingested.textPreview);
  });
});
