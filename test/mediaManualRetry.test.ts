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

const { downloadMediaMessageMock } = vi.hoisted(() => ({ downloadMediaMessageMock: vi.fn() }));
vi.mock('@whiskeysockets/baileys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@whiskeysockets/baileys')>();
  return { ...actual, downloadMediaMessage: (...args: unknown[]) => downloadMediaMessageMock(...args) };
});

const { realtimeEventsWorker, incomingMessagesWorker } = await import('../src/queue/workers/incomingMessagesWorker.js');
const { realtimeEventsQueue, enqueueMediaDownload, enqueueManualMediaRetry, MEDIA_DOWNLOAD_MAX_ATTEMPTS } = await import(
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
    pushName: 'Manual Retry Test Contact',
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

async function setupMediaMessage(
  fileSha256: Buffer,
  options: { enqueue?: boolean } = {},
): Promise<{ businessId: string; accountId: string; mediaId: string }> {
  const enqueue = options.enqueue ?? true;
  const businessId = await createTestBusiness();
  const accountId = await createTestAccount(businessId, '15550009999@s.whatsapp.net');
  const messageId = `MANUAL-RETRY-TEST-${randomBytes(6).toString('hex')}`;
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
  terminal_reason: string | null;
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

/**
 * Drives a real media row all the way to 'failed' via BullMQ's own
 * attempts/backoff, mirroring mediaRetryStateMachine.test.ts's own case 3.
 * Also waits for the underlying BullMQ job itself to leave every in-flight
 * state: the exhausted-retries handler (processMediaDownload) writes the
 * Postgres row's 'failed' status and then simply returns rather than
 * throwing, so BullMQ's own job-state bookkeeping (typically 'completed')
 * can lag a moment behind the DB write becoming visible.
 */
async function driveToFailed(businessId: string, mediaId: string): Promise<void> {
  await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 20_000);
  const row = await fetchMediaRow(mediaId);
  expect(row.download_status).toBe('failed');
  await waitForJobSettled(mediaId, 5_000);
}

const IN_FLIGHT_JOB_STATES = new Set(['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']);

async function waitForJobSettled(mediaId: string, timeoutMs: number): Promise<void> {
  const jobId = `media-download-${mediaId}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await realtimeEventsQueue.getJob(jobId);
    const state = job ? await job.getState() : null;
    if (!state || !IN_FLIGHT_JOB_STATES.has(state)) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for job ${jobId} to leave an in-flight state - still "${state}"`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const createdBusinessIds: string[] = [];
async function trackBusiness(businessId: string): Promise<void> {
  createdBusinessIds.push(businessId);
}

/**
 * Manual media retry (deferred item from PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md
 * section 9 - the automatic retry state machine tested in
 * mediaRetryStateMachine.test.ts already existed; this covers the new
 * operator-facing recovery surface). Same real-Postgres/real-BullMQ,
 * mocked-Baileys-network-call convention as that file.
 */
describe('manual media retry (real BullMQ, real Postgres, mocked Baileys network call)', () => {
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

  it('resetForManualRetry only transitions a failed row, and only for the owning business', async () => {
    const mediaRepo = new WhatsAppMediaRepository(pool);
    downloadMediaMessageMock.mockRejectedValue(new Error('simulated persistent network error'));
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32));
    await trackBusiness(businessId);
    await driveToFailed(businessId, mediaId);
    const otherBusinessId = await createTestBusiness('Other Business');

    // Wrong tenant: identical to a nonexistent id, row untouched.
    expect(await mediaRepo.resetForManualRetry(mediaId, otherBusinessId)).toBeNull();
    expect((await fetchMediaRow(mediaId)).download_status).toBe('failed');

    // Real owner: transitions cleanly.
    const updated = await mediaRepo.resetForManualRetry(mediaId, businessId);
    expect(updated?.downloadStatus).toBe('retry_scheduled');
    expect((await fetchMediaRow(mediaId)).download_status).toBe('retry_scheduled');

    // Already retry_scheduled: the guard refuses a second reset (only 'failed' is a valid start state).
    expect(await mediaRepo.resetForManualRetry(mediaId, businessId)).toBeNull();
  }, 25_000);

  it('revertManualRetry reverts a retry_scheduled row back to failed with the given reason, and only from that state', async () => {
    const mediaRepo = new WhatsAppMediaRepository(pool);
    downloadMediaMessageMock.mockRejectedValue(new Error('simulated persistent network error'));
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32));
    await trackBusiness(businessId);
    await driveToFailed(businessId, mediaId);

    // A no-op from a state that isn't retry_scheduled.
    await mediaRepo.revertManualRetry(mediaId, 'should not apply');
    expect((await fetchMediaRow(mediaId)).download_status).toBe('failed');

    await mediaRepo.resetForManualRetry(mediaId, businessId);
    await mediaRepo.revertManualRetry(mediaId, 'original download data unavailable');
    const row = await fetchMediaRow(mediaId);
    expect(row.download_status).toBe('failed');
    expect(row.terminal_reason).toBe('original download data unavailable');
  }, 25_000);

  it('enqueueManualMediaRetry reports original-job-data-unavailable when no job exists under that id', async () => {
    const mediaRepo = new WhatsAppMediaRepository(pool);
    const { businessId, mediaId } = await setupMediaMessage(randomBytes(32), { enqueue: false });
    await trackBusiness(businessId);
    // Force straight to 'failed' without ever going through beginDownloadAttempt/a real job.
    await pool.query(`UPDATE whatsapp_media SET download_status = 'failed' WHERE id = $1`, [mediaId]);

    const outcome = await enqueueManualMediaRetry(mediaId);
    expect(outcome).toBe('original-job-data-unavailable');

    // The repository layer itself would have reset the row already (route
    // order: reset, then enqueue) - this test isolates the queue layer only,
    // so the row is untouched by this call in particular.
    expect((await mediaRepo.findByIdForBusiness(mediaId, businessId))?.downloadStatus).toBe('failed');
  });

  it('enqueueManualMediaRetry rejects with already-in-flight while a job for that mediaId is still delayed/waiting', async () => {
    const { businessId, accountId, mediaId } = await setupMediaMessage(randomBytes(32), { enqueue: false });
    await trackBusiness(businessId);
    const descriptor = buildMediaDescriptor(randomBytes(32), `MANUAL-RETRY-INFLIGHT-${randomBytes(6).toString('hex')}`);

    // A long delay keeps this job in the 'delayed' state for the duration of this test, never processed.
    await realtimeEventsQueue.add(
      'media-download',
      { businessId, whatsappAccountId: accountId, mediaId, mediaDescriptor: descriptor },
      { jobId: `media-download-${mediaId}`, delay: 60_000 },
    );

    const outcome = await enqueueManualMediaRetry(mediaId);
    expect(outcome).toBe('already-in-flight');
    expect(downloadMediaMessageMock).not.toHaveBeenCalled();

    // Clean up the delayed job so it doesn't fire during a later test in this file.
    const job = await realtimeEventsQueue.getJob(`media-download-${mediaId}`);
    await job?.remove();
  });

  it('a full manual-retry round trip: failed -> reused job data -> real successful re-download', async () => {
    const mediaRepo = new WhatsAppMediaRepository(pool);
    // The manual retry reuses the ORIGINAL job's data verbatim, including
    // the sender-declared SHA-256 baked into the descriptor at ingestion
    // time - so the eventual successful download must return bytes that
    // hash to this same value. The initial failing attempts must fail via a
    // network rejection (never reaching the checksum check), not a bytes
    // mismatch, or they'd exhaust the separate, much lower
    // MAX_CHECKSUM_MISMATCH_ATTEMPTS budget instead of this test's intended
    // network-failure path.
    const buffer = randomBytes(256);
    const sha256 = createHash('sha256').update(buffer).digest();
    downloadMediaMessageMock.mockRejectedValue(new Error('simulated persistent network error'));
    const { businessId, mediaId } = await setupMediaMessage(sha256);
    await trackBusiness(businessId);
    const failedRow = await driveToFailed(businessId, mediaId).then(() => fetchMediaRow(mediaId));
    const attemptsBeforeRetry = failedRow.download_attempts;
    expect(attemptsBeforeRetry).toBe(MEDIA_DOWNLOAD_MAX_ATTEMPTS);

    // Now let the retry actually succeed - same declared hash, real matching bytes this time.
    downloadMediaMessageMock.mockReset();
    downloadMediaMessageMock.mockResolvedValue(buffer);

    // Mirrors the route's own order: reset the DB row first, then enqueue.
    const updated = await mediaRepo.resetForManualRetry(mediaId, businessId);
    expect(updated?.downloadStatus).toBe('retry_scheduled');
    const outcome = await enqueueManualMediaRetry(mediaId);
    expect(outcome).toBe('enqueued');

    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 15_000);
    expect(row.download_status).toBe('downloaded');
    // Attempts keeps climbing across the automatic exhaustion and the manual
    // retry - one real observable counter, not reset to zero.
    expect(row.download_attempts).toBe(attemptsBeforeRetry + 1);

    const { rows: countRows } = await pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM whatsapp_media WHERE id = $1',
      [mediaId],
    );
    expect(Number(countRows[0]!.count)).toBe(1);
    const files = await readdir(path.join(MEDIA_STORAGE_DIR, businessId)).catch(() => []);
    expect(files).toHaveLength(1);
  }, 30_000);

  it('a second manual-retry click right after the first finds the freshly re-added job already in flight, rather than double-downloading', async () => {
    // Same declared-hash constraint as the round-trip test above: the
    // manual retry reuses the original job's descriptor verbatim, so the
    // eventually-released successful buffer must hash to whatever was
    // declared at setup time.
    const buffer = randomBytes(64);
    const sha256 = createHash('sha256').update(buffer).digest();
    downloadMediaMessageMock.mockRejectedValue(new Error('simulated persistent network error'));
    const { businessId, mediaId } = await setupMediaMessage(sha256);
    await trackBusiness(businessId);
    await driveToFailed(businessId, mediaId);

    // Held open until the second enqueue call has already run its check,
    // so the first attempt is genuinely still in-flight (not yet
    // completed/failed) when the race is exercised - otherwise the first
    // download's real speed would make this assertion flaky.
    let releaseDownload!: (buf: Buffer) => void;
    const heldDownload = new Promise<Buffer>((resolve) => {
      releaseDownload = resolve;
    });
    downloadMediaMessageMock.mockReset();
    downloadMediaMessageMock.mockImplementation(() => heldDownload);

    const mediaRepo = new WhatsAppMediaRepository(pool);
    await mediaRepo.resetForManualRetry(mediaId, businessId);
    const first = await enqueueManualMediaRetry(mediaId);
    expect(first).toBe('enqueued');

    // Give BullMQ's worker a moment to actually pick the job up and call
    // into the (currently held-open) mocked download.
    await vi.waitFor(() => expect(downloadMediaMessageMock).toHaveBeenCalledTimes(1), { timeout: 5_000 });

    // The route only permits a second call once the row is back in 'failed'
    // (resetForManualRetry's own guard) - this isolates the queue layer's
    // own defense in the case a caller ignores that and calls it again
    // immediately: it must never spin up a second real download.
    const second = await enqueueManualMediaRetry(mediaId);
    expect(second).toBe('already-in-flight');

    releaseDownload(buffer);
    const row = await waitForDownloadStatus(mediaId, ['downloaded', 'failed', 'unavailable'], 15_000);
    expect(row.download_status).toBe('downloaded');
    expect(downloadMediaMessageMock).toHaveBeenCalledTimes(1);
  }, 20_000);
});
