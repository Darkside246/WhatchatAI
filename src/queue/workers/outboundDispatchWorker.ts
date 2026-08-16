import { Worker, type Job } from 'bullmq';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { queueConnection } from '../connection.js';
import { OUTBOUND_MESSAGES_QUEUE, type OutboundMessageJobData } from '../queues/outboundMessagesQueue.js';
import { whatsappConnectionService } from '../../services/whatsappConnectionService.js';
import { retrieveMedia } from '../../media/localEncryptedMediaStorage.js';
import { publishRealtimeEvent } from '../../realtime/pubsub.js';
import { pool } from '../../db/pool.js';
import {
  WhatsAppOutboundMessageRepository,
  type WhatsAppOutboundMessageRecord,
} from '../../repositories/whatsappOutboundMessageRepository.js';

/**
 * Deliberately run in the same process as the API server (imported from
 * server/index.ts), never the separate incomingMessagesWorker.ts process.
 * The live Baileys WebSocket only exists in whichever process actually
 * called whatsappConnectionService.connect() - that's the server process.
 * A BullMQ worker in the other process would only ever see a permanently
 * disconnected whatsappConnectionService singleton and could never
 * genuinely send anything, no matter how the job itself is structured.
 */
const outboundMessageRepository = new WhatsAppOutboundMessageRepository(pool);

/**
 * Builds the real Baileys send payload for an outbound request. Media
 * bytes are decrypted from the same tenant-scoped encrypted-at-rest
 * storage inbound media uses (localEncryptedMediaStorage.ts) - never held
 * anywhere else on disk in plaintext.
 */
async function buildOutboundContent(record: WhatsAppOutboundMessageRecord): Promise<AnyMessageContent> {
  if (record.messageType === 'text') {
    if (!record.textContent) throw new Error('Outbound text message has no text_content');
    return { text: record.textContent };
  }

  if (!record.mediaStorageReference) {
    throw new Error(`Outbound ${record.messageType} message has no stored media`);
  }
  const buffer = await retrieveMedia(record.businessId, record.mediaStorageReference);

  const caption = record.caption ?? undefined;
  const mimetype = record.mediaMimeType ?? undefined;

  switch (record.messageType) {
    case 'image':
      return { image: buffer, ...(caption !== undefined && { caption }), ...(mimetype !== undefined && { mimetype }) };
    case 'video':
      return { video: buffer, ...(caption !== undefined && { caption }), ...(mimetype !== undefined && { mimetype }) };
    case 'audio':
      return { audio: buffer, mimetype: mimetype ?? 'audio/ogg; codecs=opus', ptt: false };
    case 'document':
      return {
        document: buffer,
        mimetype: mimetype ?? 'application/octet-stream',
        fileName: record.mediaFileName ?? 'file',
        ...(caption !== undefined && { caption }),
      };
    default:
      throw new Error(`Unsupported outbound message type: ${String(record.messageType)}`);
  }
}

/**
 * The real dispatch: calls the live Baileys socket's sendMessage and
 * records the real outcome. Throwing here is what triggers BullMQ's own
 * retry/backoff (defaultJobOptions on outboundMessagesQueue) - a transient
 * failure (socket reconnecting, brief network blip) gets retried
 * automatically; only once attempts are exhausted does the 'failed' handler
 * below mark the row terminally failed.
 *
 * Known limitation, stated honestly rather than hidden: if this process
 * crashes after WhatsApp has already accepted the send but before
 * markSent() commits, a retry of the same job would call sendMessage again
 * and could produce a second real message to the recipient. WhatsApp gives
 * clients no server-side dedup key for outbound sends, so this narrow
 * crash-mid-flight window cannot be fully closed from the client side.
 */
async function processOutboundMessage(job: Job<OutboundMessageJobData>): Promise<void> {
  const { outboundMessageId } = job.data;
  const record = await outboundMessageRepository.findById(outboundMessageId);
  if (!record) {
    console.error(`[OutboundDispatchWorker] No such outbound message ${outboundMessageId}`);
    return;
  }
  if (record.status === 'sent') return; // Already succeeded on a prior delivery of this job.

  if (!whatsappConnectionService.isReady()) {
    throw new Error('WhatsApp is not connected - cannot send right now');
  }
  const socket = whatsappConnectionService.getSocket();
  if (!socket) throw new Error('WhatsApp socket unavailable');

  await outboundMessageRepository.markSending(record.id);

  const content = await buildOutboundContent(record);
  const sent = await socket.sendMessage(record.toJid, content);
  const whatsappMessageId = sent?.key?.id;
  if (!whatsappMessageId) throw new Error('WhatsApp accepted the send but returned no message id');

  await outboundMessageRepository.markSent(record.id, whatsappMessageId);
  await publishRealtimeEvent({ type: 'chat.updated', businessId: record.businessId, chatId: record.chatId });
}

const OUTBOUND_CONCURRENCY = Number(process.env.OUTBOUND_MESSAGES_WORKER_CONCURRENCY ?? 2);

export const outboundMessagesWorker = new Worker<OutboundMessageJobData>(OUTBOUND_MESSAGES_QUEUE, processOutboundMessage, {
  connection: queueConnection,
  concurrency: OUTBOUND_CONCURRENCY,
});

// BullMQ fires 'failed' after every attempt, not only the last one - a job
// with retries left simply gets rescheduled by BullMQ itself, and the DB
// row (still 'sending' from the attempt that just threw) correctly stays
// that way until either a later attempt succeeds or this really was the
// final attempt, at which point the row is marked terminally 'failed'.
outboundMessagesWorker.on('failed', (job, error) => {
  console.error(`[OutboundDispatchWorker] Attempt failed for ${job?.data.outboundMessageId}:`, error.message);
  const attemptsMade = job?.attemptsMade ?? 0;
  const maxAttempts = job?.opts.attempts ?? 1;
  if (job && attemptsMade >= maxAttempts) {
    void outboundMessageRepository.markFailed(job.data.outboundMessageId, error.message).catch((markError) => {
      console.error('[OutboundDispatchWorker] Failed to record terminal failure:', markError);
    });
  }
});

outboundMessagesWorker.on('error', (error) => {
  console.error('[OutboundDispatchWorker] Worker error:', error.message);
});

console.log(
  `[OutboundDispatchWorker] Listening on queue "${OUTBOUND_MESSAGES_QUEUE}" (concurrency=${OUTBOUND_CONCURRENCY})`,
);
