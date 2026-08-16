import { afterAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import { WhatsAppStatusRepository } from '../src/repositories/whatsappStatusRepository.js';
import { WhatsAppMediaRepository } from '../src/repositories/whatsappMediaRepository.js';
import { workspaceService } from '../src/services/workspaceService.js';
import { realtimeEventsWorker } from '../src/queue/workers/incomingMessagesWorker.js';
import { realtimeEventsQueue, enqueueStatusUpdate } from '../src/queue/queues/realtimeEventsQueue.js';
import { encodeBuffersForQueue } from '../src/domain/whatsapp/binaryCodec.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';

const MEDIA_STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR ?? './data/media-storage');

function buildStatusIngested(overrides: Partial<IngestedWhatsAppMessage> & { messageId: string }): IngestedWhatsAppMessage {
  return {
    remoteJid: 'status@broadcast',
    jidKind: 'individual',
    phoneNumber: null,
    participant: '15550007777@s.whatsapp.net',
    fromMe: false,
    pushName: 'Status Test Contact',
    isLive: true,
    upsertType: 'notify',
    messageTimestamp: new Date().toISOString(),
    contentType: 'image',
    documentSubtype: null,
    mimetype: 'image/jpeg',
    fileName: null,
    textPreview: null,
    ingestedAt: new Date().toISOString(),
    mediaDescriptor: null,
    ...overrides,
  };
}

describe('status media pipeline (real BullMQ job, real Postgres, no live socket)', () => {
  let businessId: string;
  let accountId: string;

  afterAll(async () => {
    await realtimeEventsWorker.close();
    await realtimeEventsQueue.close();
    if (businessId) await rm(path.join(MEDIA_STORAGE_DIR, businessId), { recursive: true, force: true });
  });

  it('creates a real media row owned by the status (not a message) and queues a real, honestly-outcomed download', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const statusId = `STATUS-MEDIA-${Date.now()}`;
    const mediaDescriptor = encodeBuffersForQueue({
      key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false, participant: '15550007777@s.whatsapp.net' },
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/v/t62.7118-24/nonexistent-status-media-does-not-exist',
          directPath: '/v/t62.7118-24/nonexistent-status-media-does-not-exist',
          mimetype: 'image/jpeg',
          mediaKey: randomBytes(32),
          fileEncSha256: randomBytes(32),
          fileSha256: randomBytes(32),
          fileLength: 12345,
        },
      },
    }) as Record<string, unknown>;

    const ingested = buildStatusIngested({ messageId: statusId, mediaDescriptor });

    const completion = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for status media-download job')), 30_000);
      realtimeEventsWorker.on('completed', function onCompleted(job) {
        if (job.name !== 'media-download') return;
        clearTimeout(timeout);
        realtimeEventsWorker.off('completed', onCompleted);
        resolve();
      });
    });

    await enqueueStatusUpdate({ businessId, whatsappAccountId: accountId, ingested });
    await completion;

    const statusRepository = new WhatsAppStatusRepository(pool);
    const [status] = await statusRepository.listByAccount(businessId, accountId);
    expect(status?.mediaId).not.toBeNull();

    const mediaRepository = new WhatsAppMediaRepository(pool);
    const media = await mediaRepository.findById(status!.mediaId!);
    expect(media?.statusId).toBe(status!.id);
    expect(media?.messageId).toBeNull();

    // Whatever the real network outcome, it can never be a fabricated success -
    // same honesty invariant as the chat-message media pipeline.
    expect(media?.downloadStatus).not.toBe('downloaded');
    expect(['failed', 'unavailable']).toContain(media?.downloadStatus);
    expect(media?.storageReference).toBeNull();

    const businessDir = path.join(MEDIA_STORAGE_DIR, businessId);
    const files = await readdir(businessDir).catch(() => []);
    expect(files).toHaveLength(0);
  }, 35_000);

  it('never creates a second media row for a duplicate replay of the same status_id', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const statusId = `STATUS-DUP-${Date.now()}`;
    const mediaDescriptor = encodeBuffersForQueue({
      key: { remoteJid: 'status@broadcast', id: statusId, fromMe: false, participant: '15550007777@s.whatsapp.net' },
      message: {
        imageMessage: {
          url: 'https://mmg.whatsapp.net/v/t62.7118-24/nonexistent-status-media-dup',
          directPath: '/v/t62.7118-24/nonexistent-status-media-dup',
          mimetype: 'image/jpeg',
          mediaKey: randomBytes(32),
          fileEncSha256: randomBytes(32),
          fileSha256: randomBytes(32),
          fileLength: 12345,
        },
      },
    }) as Record<string, unknown>;

    const ingested = buildStatusIngested({ messageId: statusId, mediaDescriptor });

    // Baileys can genuinely redeliver the same history-set batch - the
    // second, duplicate insert must never re-queue a second download.
    await enqueueStatusUpdate({ businessId, whatsappAccountId: accountId, ingested });
    await enqueueStatusUpdate({ businessId, whatsappAccountId: accountId, ingested });

    // Give both jobs a real chance to fully process (including the
    // dispatched download attempt from the first one).
    await new Promise((resolve) => setTimeout(resolve, 3000));

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM whatsapp_media WHERE status_id IS NOT NULL',
    );
    expect(Number(rows[0]!.count)).toBe(1);

    const { rows: statusRows } = await pool.query<{ count: string }>('SELECT count(*) AS count FROM whatsapp_statuses');
    expect(Number(statusRows[0]!.count)).toBe(1);
  }, 15_000);

  it('reports real, honest mediaAvailable/media through workspaceService.listStatuses', async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    accountId = await createTestAccount(businessId);

    const statusRepository = new WhatsAppStatusRepository(pool);
    const mediaRepository = new WhatsAppMediaRepository(pool);

    const status = await statusRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      statusId: 'STATUS-WORKSPACE-1',
      publisherJid: '15550007777@s.whatsapp.net',
      statusType: 'image',
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId: accountId,
      statusId: status.id,
      mediaType: 'image',
      mimeType: 'image/jpeg',
    });
    await statusRepository.attachMedia(status.id, media.id);

    // Still pending - real code must never claim it's available yet.
    let summaries = await workspaceService.listStatuses(businessId, accountId);
    expect(summaries[0]?.mediaAvailable).toBe(false);
    expect(summaries[0]?.media?.downloadStatus).toBe('pending');

    await mediaRepository.setDownloadResult(media.id, 'downloaded', `${businessId}/deadbeef`, 'deadbeef', 999);

    summaries = await workspaceService.listStatuses(businessId, accountId);
    expect(summaries[0]?.mediaAvailable).toBe(true);
    expect(summaries[0]?.media?.id).toBe(media.id);
  });
});
