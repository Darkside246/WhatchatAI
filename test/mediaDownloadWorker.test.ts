import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import { whatsappMessagePersistenceService } from '../src/services/whatsappMessagePersistenceService.js';
import { realtimeEventsWorker, incomingMessagesWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import { realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { encodeBuffersForQueue } from '../src/domain/whatsapp/binaryCodec.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';

const MEDIA_STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR ?? './data/media-storage');

/**
 * This is a real end-to-end run of the real media pipeline: persist() enqueues
 * a real BullMQ job, the real worker calls Baileys' real downloadMediaMessage
 * against a real HTTPS URL that does not correspond to any real media. There
 * is no live WhatsApp socket in this test process (this worker never has
 * one), so this is exactly the code path a genuinely expired/unreachable
 * media message takes in production. The point of the test is the *honesty*
 * invariant: whatever the real network outcome is, the pipeline must never
 * report 'downloaded' or create a stored file for bytes it never actually
 * received.
 */
describe('media download worker (real BullMQ job, real Baileys downloadMediaMessage call, no live socket)', () => {
  let businessId: string;
  let accountId: string;
  const accountJid = '15550009999@s.whatsapp.net';

  afterAll(async () => {
    await realtimeEventsWorker.close();
    await incomingMessagesWorker.close();
    await realtimeEventsQueue.close();
    await incomingMessagesQueue.close();
    if (businessId) await rm(path.join(MEDIA_STORAGE_DIR, businessId), { recursive: true, force: true });
  });

  it('never fabricates a downloaded file for media it could not really fetch', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId, accountJid);

    const messageId = `MEDIA-DOWNLOAD-${Date.now()}`;
    const mediaDescriptor = encodeBuffersForQueue({
      key: { remoteJid: '15550008888@s.whatsapp.net', id: messageId, fromMe: false },
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/v/t62.7118-24/nonexistent-test-media-does-not-exist',
          directPath: '/v/t62.7118-24/nonexistent-test-media-does-not-exist',
          mimetype: 'image/jpeg',
          mediaKey: randomBytes(32),
          fileEncSha256: randomBytes(32),
          fileSha256: randomBytes(32),
          fileLength: 54321,
        },
      },
    }) as Record<string, unknown>;

    const ingested: IngestedWhatsAppMessage = {
      messageId,
      remoteJid: '15550008888@s.whatsapp.net',
      jidKind: 'individual',
      phoneNumber: '+15550008888',
      participant: null,
      fromMe: false,
      pushName: 'Media Test Contact',
      isLive: true,
      upsertType: 'notify',
      messageTimestamp: new Date().toISOString(),
      contentType: 'image',
      documentSubtype: null,
      mimetype: 'image/jpeg',
      fileName: null,
      textPreview: null,
      ingestedAt: new Date().toISOString(),
      mediaDescriptor,
    };

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for media-download job')), 30_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'media-download') return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    const result = await whatsappMessagePersistenceService.persist({
      businessId,
      whatsappAccountId: accountId,
      accountJid,
      ingested,
    });
    expect(result.media).not.toBeNull();

    await completion;

    const { rows } = await pool.query<{ download_status: string; storage_reference: string | null; sha256: string | null }>(
      'SELECT download_status, storage_reference, sha256 FROM whatsapp_media WHERE id = $1',
      [result.media!.id],
    );
    const media = rows[0]!;

    // Whatever the real network outcome, it can never be a fabricated success.
    expect(media.download_status).not.toBe('downloaded');
    expect(['failed', 'unavailable']).toContain(media.download_status);
    expect(media.storage_reference).toBeNull();
    expect(media.sha256).toBeNull();

    // And no file was ever written for bytes that were never really received.
    const businessDir = path.join(MEDIA_STORAGE_DIR, businessId);
    const files = await readdir(businessDir).catch(() => []);
    expect(files).toHaveLength(0);
  }, 35_000);
});
