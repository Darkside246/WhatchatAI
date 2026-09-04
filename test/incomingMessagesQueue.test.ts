import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WhatsAppChatRepository } from '../src/repositories/whatsappChatRepository.js';
import { WhatsAppMessageRepository } from '../src/repositories/whatsappMessageRepository.js';
import { enqueueIncomingMessage, incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { incomingMessagesWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import { waitForIncomingMessageJob } from './waitForWorkerEvent.js';

describe('incoming_messages BullMQ pipeline (real Redis queue + real worker + real Postgres)', () => {
  let businessId: string;
  let accountId: string;
  let accountJid: string;

  /**
   * AURA engineering directive, "Remove race conditions" (2026-09-04) -
   * see the identical comment in aiReplyWorkerIntegration.test.ts. This
   * file is frequently whichever file in the suite first imports (and so
   * first triggers the connection startup of) the shared
   * incomingMessagesQueue/Worker singletons, making it one of the two
   * most exposed to the cold-start race this removes.
   */
  beforeAll(async () => {
    await Promise.all([incomingMessagesWorker.waitUntilReady(), incomingMessagesQueue.waitUntilReady()]);
  });

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
      remoteJidAlt: null,
      participantAlt: null,
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
      fullText: 'Message delivered through the real BullMQ pipeline',
      mediaDescriptor: null,
      ingestedAt: new Date().toISOString(),
    };

    // AURA engineering directive, "Remove race conditions" (2026-09-04):
    // listener registered (inside waitForIncomingMessageJob) before the job
    // is created below - see test/waitForWorkerEvent.ts for the leak-on-
    // timeout bug this shared helper fixes over the previous inline copy.
    const completion = waitForIncomingMessageJob(incomingMessagesWorker, messageId);

    await enqueueIncomingMessage({ businessId, whatsappAccountId: accountId, accountJid, message: ingested });
    await completion;

    const messageRepository = new WhatsAppMessageRepository(pool);
    const persisted = await messageRepository.findByWhatsAppId(businessId, accountId, messageId);
    expect(persisted).not.toBeNull();
    // The real, untruncated text (fullText) is what's persisted, never the
    // truncated preview - see whatsappMessagePersistenceService.ts.
    expect(persisted?.textContent).toBe(ingested.fullText);

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
