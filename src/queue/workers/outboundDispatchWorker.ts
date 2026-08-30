import { Worker, type Job } from 'bullmq';
import type { AnyMessageContent } from '@whiskeysockets/baileys';
import { queueConnection } from '../connection.js';
import { OUTBOUND_MESSAGES_QUEUE, type OutboundMessageJobData } from '../queues/outboundMessagesQueue.js';
import { whatsappConnectionManager } from '../../services/whatsappConnectionManager.js';
import { retrieveMedia } from '../../media/localEncryptedMediaStorage.js';
import { publishRealtimeEvent } from '../../realtime/pubsub.js';
import { notifyBusiness } from '../../services/notificationService.js';
import { pool } from '../../db/pool.js';
import {
  WhatsAppOutboundMessageRepository,
  type WhatsAppOutboundMessageRecord,
} from '../../repositories/whatsappOutboundMessageRepository.js';

/**
 * Deliberately run in the same process as the API server (imported from
 * server/index.ts), never the separate incomingMessagesWorker.ts process.
 * Every tenant's live Baileys WebSocket only exists in whichever process
 * actually called whatsappConnectionManager.connect(businessId) - that's
 * the server process. A BullMQ worker in the other process would only ever
 * see an empty, permanently-disconnected manager and could never genuinely
 * send anything, no matter how the job itself is structured.
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
    case 'voice_note':
      // ptt=true is what makes WhatsApp render this as a voice note with a
      // waveform rather than a file attachment. The bytes are already
      // Ogg/Opus - audioTranscodeService guarantees that before the row is
      // ever created, because WhatsApp will not play anything else here.
      return {
        audio: buffer,
        mimetype: 'audio/ogg; codecs=opus',
        ptt: true,
        ...(record.mediaDurationSeconds !== null && record.mediaDurationSeconds !== undefined
          ? { seconds: record.mediaDurationSeconds }
          : {}),
      };
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
 * The crash-mid-flight window is closed, not just documented: WhatsApp
 * gives clients no server-side dedup key for outbound sends, so a naive
 * retry after a crash between "WhatsApp accepted the send" and "markSent()
 * committed" would produce a real duplicate message. markSendAttempted()
 * commits the instant before sendMessage is called, so a resumed attempt
 * that finds it already set knows the previous attempt may have reached
 * WhatsApp and must not call sendMessage again - it is marked
 * 'indeterminate' and left for a human to check the real chat, instead of
 * either silently double-sending or silently retrying forever.
 */
async function processOutboundMessage(job: Job<OutboundMessageJobData>): Promise<void> {
  const { outboundMessageId } = job.data;
  const record = await outboundMessageRepository.findById(outboundMessageId);
  if (!record) {
    console.error(`[OutboundDispatchWorker] No such outbound message ${outboundMessageId}`);
    return;
  }
  if (record.status === 'sent' || record.status === 'indeterminate') return; // Already resolved on a prior delivery of this job.

  if (record.sendAttemptedAt) {
    const reason =
      'A previous attempt reached the point of calling WhatsApp before this worker restarted or the job was redelivered - ' +
      'whether the message actually sent is unknown, so it was not retried automatically.';
    console.warn(`[OutboundDispatchWorker] Outbound message ${record.id}: ${reason}`);
    await outboundMessageRepository.markIndeterminate(record.id, reason);
    await notifyBusiness({
      businessId: record.businessId,
      type: 'AUTOMATION_FAILURE',
      severity: 'warning',
      title: 'A WhatsApp send needs a manual check',
      body: 'A message send was interrupted and we cannot confirm whether it reached the recipient. Check the chat before resending.',
      targetType: 'chat',
      targetId: record.chatId,
    }).catch((error) => {
      console.error('[OutboundDispatchWorker] Failed to dispatch AUTOMATION_FAILURE notification:', error);
    });
    return;
  }

  if (!whatsappConnectionManager.isReady(record.businessId)) {
    throw new Error('WhatsApp is not connected - cannot send right now');
  }
  const socket = whatsappConnectionManager.getSocket(record.businessId);
  if (!socket) throw new Error('WhatsApp socket unavailable');

  await outboundMessageRepository.markSending(record.id);

  const content = await buildOutboundContent(record);

  // Committed right before the real network call - see markSendAttempted's
  // own doc comment for why this must be a separate write from markSending.
  await outboundMessageRepository.markSendAttempted(record.id);

  let sent: Awaited<ReturnType<typeof socket.sendMessage>>;
  try {
    sent = await socket.sendMessage(record.toJid, content);
  } catch (error) {
    // sendMessage itself threw: we are still running, so we know for
    // certain no message id was ever returned - this is an ordinary
    // transient failure, safe for BullMQ's normal retry/backoff exactly as
    // before. Clear the marker so that retry is not mistaken for a
    // resumed, possibly-already-sent attempt.
    await outboundMessageRepository.clearSendAttempted(record.id);
    throw error;
  }

  const whatsappMessageId = sent?.key?.id;
  if (!whatsappMessageId) {
    await outboundMessageRepository.clearSendAttempted(record.id);
    throw new Error('WhatsApp accepted the send but returned no message id');
  }

  // Past this point WhatsApp has genuinely already sent the message. The
  // marker deliberately stays set: if markSent() itself now fails (e.g. a
  // transient DB error) and this job gets retried, the top-of-function
  // check must refuse to call sendMessage again - a known-good send is
  // worth a manual reconciliation, never a risk of sending it twice.
  await outboundMessageRepository.markSent(record.id, whatsappMessageId);
  await publishRealtimeEvent({ type: 'chat.updated', businessId: record.businessId, chatId: record.chatId });
}

const OUTBOUND_CONCURRENCY = Number(process.env.OUTBOUND_MESSAGES_WORKER_CONCURRENCY ?? 2);

// A stalled Baileys socket (rate limit, phone offline, QR expiry) lets
// outbound jobs pile up in the queue for as long as the outage lasts. Without
// this, the moment the socket reconnects every queued job fires at once -
// exactly the kind of burst WhatsApp's own abuse detection reads as spam and
// can respond to by banning the number. `limiter` caps how many jobs this
// worker pulls per window regardless of backlog size, so a reconnect drains
// the backlog at a steady rate instead of dumping it in one burst. Global
// across all businesses sharing this process, not per-JID - a coarser but
// far simpler bound that still eliminates the burst-on-reconnect failure mode.
const OUTBOUND_RATE_LIMIT_MAX = Number(process.env.OUTBOUND_MESSAGES_RATE_LIMIT_MAX ?? 10);
const OUTBOUND_RATE_LIMIT_DURATION_MS = Number(process.env.OUTBOUND_MESSAGES_RATE_LIMIT_DURATION_MS ?? 1000);

export const outboundMessagesWorker = new Worker<OutboundMessageJobData>(OUTBOUND_MESSAGES_QUEUE, processOutboundMessage, {
  connection: queueConnection,
  concurrency: OUTBOUND_CONCURRENCY,
  limiter: { max: OUTBOUND_RATE_LIMIT_MAX, duration: OUTBOUND_RATE_LIMIT_DURATION_MS },
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
  `[OutboundDispatchWorker] Listening on queue "${OUTBOUND_MESSAGES_QUEUE}" (concurrency=${OUTBOUND_CONCURRENCY}, rate limit=${OUTBOUND_RATE_LIMIT_MAX}/${OUTBOUND_RATE_LIMIT_DURATION_MS}ms)`,
);
