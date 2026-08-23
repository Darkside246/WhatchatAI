import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, createHash } from 'node:crypto';
import path from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { pool } from '../src/db/pool.js';
import { WhatsAppMediaRepository } from '../src/repositories/whatsappMediaRepository.js';
import { encodeBuffersForQueue } from '../src/domain/whatsapp/binaryCodec.js';
import { createTestAccount, createTestBusiness, resetDatabase } from './helpers.js';
import type { IngestedWhatsAppMessage } from '../src/services/whatsappMessageIngestionService.js';

const MEDIA_STORAGE_DIR = path.resolve(process.env.MEDIA_STORAGE_DIR ?? './data/media-storage');

// Small threshold so the "oversized" test case can use a tiny buffer instead
// of allocating real megabytes - must be set before the worker module (which
// reads it once, at import time) is ever imported below.
process.env.MEDIA_MAX_DOWNLOAD_BYTES = '4096';

// The one external boundary this suite controls: Baileys' own network call.
// Everything else (BullMQ, Postgres, the encrypted storage layer, the real
// guarded state-machine repository methods) stays real, matching this
// codebase's established convention (see test/emailSendWorker.test.ts).
const { downloadMediaMessageMock } = vi.hoisted(() => ({ downloadMediaMessageMock: vi.fn() }));
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, downloadMediaMessage: (...args: unknown[]) => downloadMediaMessageMock(...args) };
});

const { realtimeEventsWorker, incomingMessagesWorker, sweepStaleDownloadingMedia } = await import(
  '../src/queue/workers/incomingMessagesWorker.js'
);
const { realtimeEventsQueue, enqueueMediaDownload, MEDIA_DOWNLOAD_MAX_ATTEMPTS } = await import(
  '../src/queue/queues/realtimeEventsQueue.js'
);
const { incomingMessagesQueue } = await import('../src/queue/queues/incomingMessagesQueue.js');
const { whatsappMessagePersistenceService } = await import('../src/services/whatsappMessagePersistenceService.js');

function buildMediaDescriptor(fileSha256: Buffer, messageId: string): Record<string, unknown> {
  return encodeBuffersForQueue({
    key: { remoteJid: '15550008888@s.whatsapp.net', id: messageId, fromMe: false },
    message: {
      imageMessage: {
        url: 'https://mmg.whatsapp.net/v/t62.7118-24/mock-controlled-media',
        directPath: '/v/t62.7118-24/mock-controlled-media',
        mimetype: 'image/jpeg',
        mediaKey: randomBytes(32),
        fileEncSha256: randomBytes(32),
        fileSha256,
        fileLength: 999,
      },
    },
  }) as Record<string, unknown>;
}

function buildIngested(messageId: string, mediaDescriptor: Record<string, unknown> | null): IngestedWhatsAppMessage {
  return {
    messageId,
    remoteJid: '15550008888@s.whatsapp.net',
    jidKind: 'individual',
    phoneNumber: '+15550008888',
    participant: null,
    fromMe: false,
    pushName: 'Retry Test Contact',
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
}

/**
 * Creates a real business/account/message/media row. When `enqueue` is true
 * (the default), this goes through the real persist() path, which also
 * enqueues the real BullMQ download job - exactly the production path. When
 * false, no descriptor is attached and no job is enqueued, for tests that
 * need a real media row without a live job racing their own manipulation of
 * it (the crash-recovery and duplicate-delivery-guard cases).
 */
async function setupMediaMessage(
  fileSha256: Buffer,
  options: { enqueue?: boolean } = {},
): Promise<{ businessId: string; accountId: string; mediaId: string }> {
  const enqueue = options.enqueue ?? true;
  const businessId = await createTestBusiness();
  const accountId = await createTestAccount(businessId, '15550009999@s.whatsapp.net');
  const messageId = `RETRY-TEST-${randomBytes(6).toString('hex')}`;
  const mediaDescriptor = enqueue ? buildMediaDescriptor(fileSha256, messageId) : null;

  const result = await whatsappMessagePersistenceService.persist({
    businessId,
    whatsappAccountId: accountId,
    accountJid: '15550009999@s.whatsapp.net',
    ingested: buildIngested(messageId, mediaDescriptor),
  });

  return { businessId, accountId, mediaId: result.media!.id };
}

interface MediaRow {
  download_status: string;
  download_attempts: number;
  last_attempted_at: string | null;
  last_error_category: string | null;
  last_error_message: string | null;
  next_retry_at: string | null;
  terminal_reason: string | null;
  sha256: string | null;
  storage_reference: string | null;
}

async function fetchMediaRow(mediaId: string): Promise<MediaRow> {
  const { rows } = await pool.query<MediaRow>('SELECT * FROM whatsapp_media WHERE id = $1', [mediaId]);
  const row = rows[0];
  if (!row) throw new Error(`No whatsapp_media row for ${mediaId}`);
  return row;
}

async function waitForDownloadStatus(mediaId: string, statuses: string[], timeoutMs: number): Promise<MediaRow> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await fetchMediaRow(mediaId);
    if (statuses.includes(row.download_status)) return row;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for media ${mediaId} to reach one of [${statuses.join(', ')}] - currently "${row.download_status}"`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const createdBusinessIds: string[] = [];
async function trackBusiness(businessId: string): Promise<void> {
  createdBusinessIds.push(businessId);
}

/**
 * Phase 2B: activates BullMQ's already-configured attempts/backoff for
 * media downloads via a real guarded state machine. See
 * docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md for the full design this
 * suite verifies. Only Baileys' own downloadMediaMessage is mocked (the one
 * genuinely non-deterministic external call); BullMQ, Postgres, and the
 * real encrypted storage layer are all real throughout.
 */
describe('media download retry state machine (real BullMQ, real Postgres, mocked Baileys network call)', () => {
  beforeEach(async () => {
    await resetDatabase();
    downloadMediaMessageMock.mockReset();
  });

  afterAll(async () => {
    await realtimeEventsWorker.close();
    await incomingMessagesWorker.close();
    await realtimeEventsQueue.close();
    await incomingMessagesQueue.close();
    await Promise.all(
      createdBusinessIds.map((id) => rm(path.join(MEDIA_STORAGE_DIR, id), { recursive: true, force: true })),
    );
  });

  it('1. first attempt succeeds: downloaded, attempts=1, real bytes stored exactly once', async () => {
    const buffer = randomBytes(256);
    const sha256 = createHash('sha256').update(buffer).digest();
    downloadMediaMessageMock.mockResolvedValue(buffer);

    const { businessId, mediaId } = await setupMediaMessage(sha256);
    await trackBusiness(businessId);

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 10_000);
    expect(row.download_status).toBe('downloaded');
    expect(row.download_attempts).toBe(1);
    expect(row.sha256).toBe(sha256.toString('hex'));
    expect(row.storage_reference).toBe(`${businessId}/${sha256.toString('hex')}`);
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(1);

    const files = await readdir(path.join(MEDIA_STORAGE_DIR, businessId)).catch(() => []);
    expect(files).toHaveLength(1);
  }, 15_000);

  it('2. a retryable failure schedules a retry, and a subsequent attempt succeeds', async () => {
    const buffer = randomBytes(256);
    const sha256 = createHash('sha256').update(buffer).digest();
    downloadMediaMessageMock.mockRejectedValueOnce(new Error('simulated transient network error')).mockResolvedValueOnce(buffer);

    const { businessId, mediaId } = await setupMediaMessage(sha256);
    await trackBusiness(businessId);

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 15_000);
    expect(row.download_status).toBe('downloaded');
    expect(row.download_attempts).toBe(2); // proves it really did retry once, not succeed on the first try
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('3. maximum attempts reached on a persistently retryable failure - final state failed, terminal_reason set, sanitized', async () => {
    downloadMediaMessageMock.mockRejectedValue(new Error('simulated persistent network error with a very long message '.repeat(20)));

    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32));
    await trackBusiness(businessId);

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 20_000);
    expect(row.download_status).toBe('failed');
    expect(row.download_attempts).toBe(MEDIA_DOWNLOAD_MAX_ATTEMPTS);
    expect(row.terminal_reason).toBeTruthy();
    expect(row.last_error_category).toBe('network');
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(MEDIA_DOWNLOAD_MAX_ATTEMPTS);

    // Observability sanitization discipline (PHASE_2A section 8): short,
    // single-line, never a raw stack trace dump.
    expect(row.last_error_message).not.toBeNull();
    expect(row.last_error_message!.length).toBeLessThanOrEqual(301); // capped length plus the truncation ellipsis
    expect(row.last_error_message).not.toContain('\n');
    expect(row.last_error_message).not.toMatch(/at Object\.|at async|node_modules/); // no raw stack frame text
  }, 25_000);

  it('4a. an oversized buffer is terminal on the first attempt - never retried', async () => {
    const oversized = randomBytes(5000); // exceeds this file's MEDIA_MAX_DOWNLOAD_BYTES=4096 override
    downloadMediaMessageMock.mockResolvedValue(oversized);

    const { businessId, mediaId } = await setupMediaMessage(createHash('sha256').update(oversized).digest());
    await trackBusiness(businessId);

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 8_000);
    expect(row.download_status).toBe('failed');
    expect(row.download_attempts).toBe(1);
    expect(row.last_error_category).toBe('oversized');
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('4b. a 404 from the CDN is terminal (unavailable) on the first attempt - never retried', async () => {
    downloadMediaMessageMock.mockRejectedValue(Object.assign(new Error('Not Found'), { output: { statusCode: 404 } }));

    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32));
    await trackBusiness(businessId);

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 8_000);
    expect(row.download_status).toBe('unavailable');
    expect(row.download_attempts).toBe(1);
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(1);
  }, 10_000);

  it('5. a checksum mismatch is retried at most once, even though the general attempts cap is higher', async () => {
    const buffer = randomBytes(256);
    const wrongSha256 = randomBytes(32); // deliberately never matches `buffer`
    downloadMediaMessageMock.mockResolvedValue(buffer);

    const { businessId, mediaId } = await setupMediaMessage(wrongSha256);
    await trackBusiness(businessId);

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 15_000);
    expect(row.download_status).toBe('failed');
    expect(row.download_attempts).toBe(2);
    expect(row.download_attempts).toBeLessThan(MEDIA_DOWNLOAD_MAX_ATTEMPTS);
    expect(row.last_error_category).toBe('checksum_mismatch');
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(2);

    // A checksum failure never stores the (wrongly-verified) bytes.
    const files = await readdir(path.join(MEDIA_STORAGE_DIR, businessId)).catch(() => []);
    expect(files).toHaveLength(0);
  }, 20_000);

  it('6. crash-recovery sweep reconciles a stuck downloading row to failed - no descriptor persisted to auto-resume', async () => {
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32), { enqueue: false });
    await trackBusiness(businessId);

    // Simulate a worker process that died mid-download: force the row into
    // 'downloading' and backdate it past the sweep's staleness threshold.
    await pool.query(
      `UPDATE whatsapp_media SET download_status = 'downloading', download_attempts = 1, updated_at = now() - interval '10 minutes' WHERE id = $1`,
      [mediaId],
    );

    await sweepStaleDownloadingMedia();

    const row = await fetchMediaRow(mediaId);
    expect(row.download_status).toBe('failed');
    expect(row.last_error_category).toBe('internal');
    expect(row.terminal_reason).toContain('crash');
    expect(downloadMediaMessageMock).not.toHaveBeenCalled(); // never attempts a real re-download it cannot safely make
  }, 10_000);

  it('6b. the sweep leaves a genuinely recent in-flight download alone', async () => {
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32), { enqueue: false });
    await trackBusiness(businessId);

    await pool.query(`UPDATE whatsapp_media SET download_status = 'downloading', updated_at = now() WHERE id = $1`, [mediaId]);

    await sweepStaleDownloadingMedia();

    const row = await fetchMediaRow(mediaId);
    expect(row.download_status).toBe('downloading'); // untouched - not actually stale
  }, 10_000);

  it('7. a duplicate/redelivered attempt against an already-resolved row is a safe no-op', async () => {
    const mediaRepo = new WhatsAppMediaRepository(pool);
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32), { enqueue: false });
    await trackBusiness(businessId);

    const first = await mediaRepo.beginDownloadAttempt(mediaId, ['pending', 'retry_scheduled']);
    expect(first.started).toBe(true);
    const completed = await mediaRepo.completeDownload(mediaId, `${businessId}/deadbeef`, 'deadbeef'.padEnd(64, '0'), 10);
    expect(completed).toBe(true);

    // A redelivered job for the same media, arriving after it already
    // resolved, finds the row no longer in an eligible starting state.
    const duplicate = await mediaRepo.beginDownloadAttempt(mediaId, ['pending', 'retry_scheduled']);
    expect(duplicate.started).toBe(false);

    const row = await fetchMediaRow(mediaId);
    expect(row.download_status).toBe('downloaded'); // untouched by the no-op duplicate
    expect(row.download_attempts).toBe(1);
  });

  it('7b. the same guard applies from an already-terminal failed state', async () => {
    const mediaRepo = new WhatsAppMediaRepository(pool);
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32), { enqueue: false });
    await trackBusiness(businessId);

    await mediaRepo.beginDownloadAttempt(mediaId, ['pending', 'retry_scheduled']);
    await mediaRepo.failTerminally(mediaId, 'failed', 'internal', 'simulated terminal error', 'simulated terminal error');

    const duplicate = await mediaRepo.beginDownloadAttempt(mediaId, ['pending', 'retry_scheduled']);
    expect(duplicate.started).toBe(false);

    const row = await fetchMediaRow(mediaId);
    expect(row.download_status).toBe('failed');
  });

  it('8. two concurrent enqueue attempts for the same mediaId are deduped at the queue layer - only one real download', async () => {
    const buffer = randomBytes(64);
    const sha256 = createHash('sha256').update(buffer).digest();
    downloadMediaMessageMock.mockResolvedValue(buffer);

    const { businessId, accountId, mediaId } = await setupMediaMessage(sha256, { enqueue: false });
    await trackBusiness(businessId);
    const descriptor = buildMediaDescriptor(sha256, `RETRY-TEST-DUP-${randomBytes(6).toString('hex')}`);

    await Promise.all([
      enqueueMediaDownload({ businessId, whatsappAccountId: accountId, mediaId, mediaDescriptor: descriptor }),
      enqueueMediaDownload({ businessId, whatsappAccountId: accountId, mediaId, mediaDescriptor: descriptor }),
    ]);

    const row = await waitForDownloadStatus(mediaId, ['downloaded'], 10_000);
    expect(row.download_status).toBe('downloaded');
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(1); // the second .add() was deduped, never executed
  }, 15_000);

  it('9. a full retry-then-success round trip produces exactly one media row and exactly one physical file', async () => {
    const buffer = randomBytes(128);
    const sha256 = createHash('sha256').update(buffer).digest();
    downloadMediaMessageMock.mockRejectedValueOnce(new Error('transient')).mockResolvedValueOnce(buffer);

    const { businessId, mediaId } = await setupMediaMessage(sha256);
    await trackBusiness(businessId);

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 15_000);
    expect(row.download_status).toBe('downloaded');

    const { rows: countRows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM whatsapp_media WHERE id = $1',
      [mediaId],
    );
    expect(Number(countRows[0]!.count)).toBe(1);

    const files = await readdir(path.join(MEDIA_STORAGE_DIR, businessId)).catch(() => []);
    expect(files).toHaveLength(1);
  }, 20_000);

  it('cross-tenant: a media row is not visible to findByIdForBusiness from a different business', async () => {
    const mediaRepo = new WhatsAppMediaRepository(pool);
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32), { enqueue: false });
    await trackBusiness(businessId);
    const otherBusinessId = await createTestBusiness('Other Business');

    expect(await mediaRepo.findByIdForBusiness(mediaId, otherBusinessId)).toBeNull();
    expect((await mediaRepo.findByIdForBusiness(mediaId, businessId))?.id).toBe(mediaId);
  });
});
