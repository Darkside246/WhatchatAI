import { Worker, type Job } from 'bullmq';
import type { AnyMessageContent, MiscMessageGenerationOptions } from '@whiskeysockets/baileys';
import { queueConnection } from '../connection.js';
import { OUTBOUND_MESSAGES_QUEUE, type OutboundMessageJobData } from '../queues/outboundMessagesQueue.js';
import { whatsappConnectionManager } from '../../services/whatsappConnectionManager.js';
import { retrieveMedia } from '../../media/mediaStorage.js';
import { publishRealtimeEvent } from '../../realtime/pubsub.js';
import { notifyBusiness } from '../../services/notificationService.js';
import { pool } from '../../db/pool.js';
import {
  WhatsAppOutboundMessageRepository,
  type WhatsAppOutboundMessageRecord,
} from '../../repositories/whatsappOutboundMessageRepository.js';
import { computeTypingDelayMs, sleep } from '../../services/humanlikeTypingDelay.js';
import { WhatsAppStatusRepository } from '../../repositories/whatsappStatusRepository.js';

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
const statusRepository = new WhatsAppStatusRepository(pool);

/**
 * Builds the real Baileys send payload for an outbound request. Media
 * bytes are decrypted from the same tenant-scoped encrypted-at-rest
 * storage inbound media uses (localEncryptedMediaStorage.ts) - never held
 * anywhere else on disk in plaintext.
 */
/**
 * A minimal but genuinely valid vCard 3.0 - the format WhatsApp expects for
 * a shared contact. Only the two fields we actually have are emitted; no
 * placeholder organisation, email or address is invented to pad it out.
 *
 * The name is escaped per RFC 6350: a comma, semicolon or backslash in a
 * real person's name would otherwise terminate a field early and corrupt
 * the card on the recipient's phone.
 */
function buildVCard(displayName: string, phoneNumber: string): string {
  const escape = (value: string): string => value.replace(/([\\;,])/g, '\\$1').replace(/\n/g, '\\n');
  const name = escape(displayName.trim());
  const phone = phoneNumber.trim();
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${name}`,
    `N:${name};;;;`,
    `TEL;type=CELL;type=VOICE;waid=${phone.replace(/[^0-9]/g, '')}:${phone}`,
    'END:VCARD',
  ].join('\n');
}

async function buildOutboundContent(record: WhatsAppOutboundMessageRecord): Promise<AnyMessageContent> {
  if (record.messageType === 'text') {
    if (!record.textContent) throw new Error('Outbound text message has no text_content');
    return { text: record.textContent };
  }

  // contact and poll carry neither text nor media - their whole content is
  // the structured payload, decrypted here on demand (see
  // findStructuredPayload for why it is not a field on the record).
  if (record.messageType === 'contact' || record.messageType === 'poll') {
    const payload = await outboundMessageRepository.findStructuredPayload(record.id, record.businessId);
    if (!payload) {
      // Honest failure rather than sending an empty card or a poll with no
      // question: the send is marked failed and the operator is told.
      throw new Error(`Outbound ${record.messageType} message has no readable structured payload`);
    }

    if (payload.kind === 'contact') {
      return {
        contacts: {
          displayName:
            payload.contacts.length === 1
              ? payload.contacts[0]!.displayName
              : `${payload.contacts.length} contacts`,
          contacts: payload.contacts.map((contact) => ({ vcard: buildVCard(contact.displayName, contact.phoneNumber) })),
        },
      };
    }

    return {
      poll: {
        name: payload.question,
        values: payload.options,
        selectableCount: payload.selectableCount,
      },
    };
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
  if (record.status === 'sent' || record.status === 'indeterminate' || record.status === 'cancelled') return; // Already resolved on a prior delivery of this job, or stopped by a real cancel.

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

  // Real "typing…" indicator + a real, length-scaled delay before an
  // AI-generated reply actually sends - never for a human-composed send
  // (requestedBy: 'human'/'campaign'/'funnel'/'system'), which has already
  // taken real human time to write. Must happen here, in this worker, not
  // in whatsappOutboundMessageService.ts's own send() call - that method
  // is also called from incomingMessagesWorker.ts, a separate process
  // with no live Baileys socket of its own (see this file's own doc
  // comment on why dispatch itself has to live in the server process).
  // Presence-update failures are logged and swallowed, never allowed to
  // block or fail the actual send - the indicator is a nicety, the
  // message itself is not.
  if (record.requestedBy === 'ai' && record.messageType === 'text' && record.textContent) {
    try {
      await socket.sendPresenceUpdate('composing', record.toJid);
    } catch (error) {
      console.error(`[OutboundDispatchWorker] Failed to send 'composing' presence for ${record.id}:`, error);
    }
    await sleep(computeTypingDelayMs(record.textContent));
    try {
      await socket.sendPresenceUpdate('paused', record.toJid);
    } catch {
      // Best-effort only - WhatsApp clears the indicator once the message itself arrives regardless.
    }
  }

  // Committed right before the real network call - see markSendAttempted's
  // own doc comment for why this must be a separate write from markSending.
  await outboundMessageRepository.markSendAttempted(record.id);

  /**
   * A WhatsApp status reply is an ordinary direct message that QUOTES the
   * status, which is what makes both sides see it threaded under the right
   * post. Without the quote the recipient gets a bare message with no idea
   * what it refers to.
   *
   * The quoted stub is keyed on status@broadcast with the status's own
   * WhatsApp id and its publisher as participant - the real identifiers
   * WhatsApp itself uses for a status, never invented ones. If the status
   * row has since been cleaned up (they expire after 24 hours) the message
   * is sent as a plain DM rather than failing: the reply is still real and
   * still wanted.
   */
  let sendOptions: MiscMessageGenerationOptions | undefined;
  if (record.replyToStatusId) {
    const status = await statusRepository.findByIdForBusiness(record.replyToStatusId, record.businessId);
    if (status) {
      sendOptions = {
        quoted: {
          key: { remoteJid: 'status@broadcast', id: status.statusId, participant: status.publisherJid, fromMe: false },
          message: { conversation: status.textContent ?? '' },
        },
      };
    } else {
      console.warn(
        `[OutboundDispatchWorker] Status ${record.replyToStatusId} is gone (expired or cleaned up) - sending outbound ${record.id} as a plain message.`,
      );
    }
  }

  let sent: Awaited<ReturnType<typeof socket.sendMessage>>;
  try {
    // Only passes a third argument when there genuinely is one: an ordinary
    // send keeps the exact call shape it has always had, rather than
    // acquiring a trailing `undefined`.
    sent = sendOptions
      ? await socket.sendMessage(record.toJid, content, sendOptions)
      : await socket.sendMessage(record.toJid, content);
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
