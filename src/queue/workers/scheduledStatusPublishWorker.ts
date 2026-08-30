import { Worker, type Job } from 'bullmq';
import { queueConnection } from '../connection.js';
import { SCHEDULED_STATUSES_QUEUE, type ScheduledStatusJobData } from '../queues/scheduledStatusesQueue.js';
import { whatsappConnectionManager } from '../../services/whatsappConnectionManager.js';
import { retrieveMedia } from '../../media/localEncryptedMediaStorage.js';
import { pool } from '../../db/pool.js';
import { ScheduledStatusRepository, type ScheduledStatusRecord } from '../../repositories/scheduledStatusRepository.js';
import { WhatsAppContactRepository } from '../../repositories/whatsappContactRepository.js';

/**
 * Deliberately runs in the same process as the API server (imported from
 * server/index.ts, same pattern as outboundDispatchWorker.ts) - the live
 * Baileys socket only exists in whichever process actually connected.
 */
const scheduledStatusRepository = new ScheduledStatusRepository(pool);
const contactRepository = new WhatsAppContactRepository(pool);

async function buildStatusContent(record: ScheduledStatusRecord) {
  if (record.statusType === 'text') {
    if (!record.textContent) throw new Error('Text status has no text_content');
    return { text: record.textContent };
  }
  if (!record.mediaStorageReference) throw new Error(`${record.statusType} status has no stored media`);
  const buffer = await retrieveMedia(record.businessId, record.mediaStorageReference);
  const caption = record.caption ?? undefined;
  const mimetype = record.mediaMimeType ?? undefined;
  if (record.statusType === 'image') {
    return { image: buffer, ...(caption !== undefined && { caption }), ...(mimetype !== undefined && { mimetype }) };
  }
  return { video: buffer, ...(caption !== undefined && { caption }), ...(mimetype !== undefined && { mimetype }) };
}

/**
 * The real publish. Status visibility (statusJidList) is populated from
 * this account's own real, saved individual contacts - never a fabricated
 * or empty audience. If WhatsApp is disconnected at fire time, or the send
 * genuinely fails, the row is marked FAILED with the real error - it is
 * never marked PUBLISHED without a real Baileys send having succeeded.
 */
async function processScheduledStatus(job: Job<ScheduledStatusJobData>): Promise<void> {
  const { scheduledStatusId } = job.data;
  const record = await scheduledStatusRepository.findById(scheduledStatusId);
  if (!record) {
    console.error(`[ScheduledStatusPublishWorker] No such scheduled status ${scheduledStatusId}`);
    return;
  }
  if (record.status === 'PUBLISHED' || record.status === 'CANCELLED') return;

  if (!whatsappConnectionManager.isReady(record.businessId)) {
    throw new Error('WhatsApp is not connected - cannot publish this status right now');
  }
  const socket = whatsappConnectionManager.getSocket(record.businessId);
  if (!socket) throw new Error('WhatsApp socket unavailable');

  await scheduledStatusRepository.updateStatus(record.id, 'PUBLISHING');

  const statusJidList = await contactRepository.listIndividualJidsForAccount(record.businessId, record.whatsappAccountId);
  const content = await buildStatusContent(record);
  const sent = await socket.sendMessage('status@broadcast', content, {
    statusJidList,
    broadcast: true,
    ...(record.backgroundColor ? { backgroundColor: record.backgroundColor } : {}),
  });

  // The key WhatsApp assigned is the only handle a later recall can use. If
  // Baileys returned no key we still publish honestly, but the status will
  // correctly report itself as not recallable.
  if (sent?.key?.id) {
    await scheduledStatusRepository.recordPublishedMessageId(record.id, sent.key.id);
  }

  await scheduledStatusRepository.updateStatus(record.id, 'PUBLISHED', { publishedAt: true });
}

const STATUS_WORKER_CONCURRENCY = Number(process.env.SCHEDULED_STATUS_WORKER_CONCURRENCY ?? 1);

export const scheduledStatusPublishWorker = new Worker<ScheduledStatusJobData>(SCHEDULED_STATUSES_QUEUE, processScheduledStatus, {
  connection: queueConnection,
  concurrency: STATUS_WORKER_CONCURRENCY,
});

scheduledStatusPublishWorker.on('failed', (job, error) => {
  console.error(`[ScheduledStatusPublishWorker] Attempt failed for ${job?.data.scheduledStatusId}:`, error.message);
  const attemptsMade = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts.attempts ?? 1;
  if (job && attemptsMade >= maxAttempts) {
    void scheduledStatusRepository.updateStatus(job.data.scheduledStatusId, 'FAILED', { lastError: error.message }).catch((markError) => {
      console.error('[ScheduledStatusPublishWorker] Failed to record terminal failure:', markError);
    });
  }
});

scheduledStatusPublishWorker.on('error', (error) => {
  console.error('[ScheduledStatusPublishWorker] Worker error:', error.message);
});

console.log(`[ScheduledStatusPublishWorker] Listening on queue "${SCHEDULED_STATUSES_QUEUE}" (concurrency=${STATUS_WORKER_CONCURRENCY})`);
