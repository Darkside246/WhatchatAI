import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import { downloadMediaMessage, type WAMessage, type WAMessageKey, type proto } from '@whiskeysockets/baileys';
import { queueConnection } from '../connection.js';
import { INCOMING_MESSAGES_QUEUE, type IncomingMessageJobData } from '../queues/incomingMessagesQueue.js';
import {
  REALTIME_EVENTS_QUEUE,
  realtimeEventsQueue,
  type MessageStatusJobData,
  type CallEventJobData,
  type StatusUpdateJobData,
  type MediaDownloadJobData,
  type MessageReactionJobData,
  type PresenceUpdateJobData,
  enqueueMediaDownload,
} from '../queues/realtimeEventsQueue.js';
import { whatsappMessagePersistenceService } from '../../services/whatsappMessagePersistenceService.js';
import { runSentinel } from '../../security/sentinel/sentinel.js';
import { gatherAiHandoffContext } from '../../services/aiContextGathererService.js';
import { generateAiReply } from '../../services/aiReplyService.js';
import { whatsappOutboundMessageService } from '../../services/whatsappOutboundMessageService.js';
import { AiAgentRepository } from '../../repositories/aiAgentRepository.js';
import { publishRealtimeEvent } from '../../realtime/pubsub.js';
import { pool } from '../../db/pool.js';
import { WhatsAppMessageRepository } from '../../repositories/whatsappMessageRepository.js';
import { WhatsAppCallRepository } from '../../repositories/whatsappCallRepository.js';
import { WhatsAppStatusRepository } from '../../repositories/whatsappStatusRepository.js';
import { WhatsAppMediaRepository } from '../../repositories/whatsappMediaRepository.js';
import { WhatsAppMessageReactionRepository } from '../../repositories/whatsappMessageReactionRepository.js';
import { WhatsAppPresenceRepository } from '../../repositories/whatsappPresenceRepository.js';
import { WhatsAppSyncJobRepository } from '../../repositories/whatsappSyncJobRepository.js';
import { WhatsAppAccountRepository } from '../../repositories/whatsappAccountRepository.js';
import { WhatsAppOutboundMessageRepository } from '../../repositories/whatsappOutboundMessageRepository.js';
import { mapBaileysCallStatus, callTypeFromEvent, isTerminalCallStatus } from '../../domain/whatsapp/callStatus.js';
import { classifyJid, derivePhoneNumber } from '../../domain/whatsapp/jid.js';
import { decodeBuffersFromQueue } from '../../domain/whatsapp/binaryCodec.js';
import { storeMedia } from '../../media/localEncryptedMediaStorage.js';
import type { MediaType, StatusType } from '../../domain/whatsapp/types.js';

/**
 * Drains the incoming_messages queue and performs the real Postgres
 * persistence (contact/chat upsert + encrypted message insert) off the
 * Baileys WebSocket event loop. Run as its own process: `npm run dev:worker`.
 *
 * The Tiered Security Sentinel runs here, in the background worker, before
 * any business logic: messages the Sentinel blocks are logged to
 * security_audit_logs and never reach persistence.
 */
async function processJob(job: Job<IncomingMessageJobData>): Promise<void> {
  const { businessId, whatsappAccountId, accountJid, message } = job.data;

  const verdict = await runSentinel({
    businessId,
    whatsappAccountId,
    senderJid: message.fromMe ? accountJid : (message.participant ?? message.remoteJid),
    textContent: message.textPreview,
    mimetype: message.mimetype,
    fileName: message.fileName,
  });

  if (!verdict.allowed) {
    console.warn(`[IncomingMessagesWorker] Sentinel blocked message ${message.messageId}: ${verdict.reason}`);
    return;
  }

  const result = await whatsappMessagePersistenceService.persist({
    businessId,
    whatsappAccountId,
    accountJid,
    ingested: message,
  });

  if (result.message.wasInserted) {
    await publishRealtimeEvent({ type: 'message.new', businessId, chatId: result.chat.id });
    await publishRealtimeEvent({ type: 'chat.updated', businessId, chatId: result.chat.id });

    // The message we just persisted may be the echo of our own outbound
    // send (Baileys re-delivers a sent message through the same
    // messages.upsert path, fromMe: true) - link it back to the send
    // request that triggered it, best-effort, so the outbound row's
    // message_id catches up once this async persistence completes.
    if (message.fromMe) {
      await outboundMessageRepository
        .linkPersistedMessage(whatsappAccountId, result.message.whatsappMessageId, result.message.id)
        .catch((error) => {
          console.error('[IncomingMessagesWorker] Failed to link outbound message:', error);
        });
    }
  }

  // Only a genuinely new, live, inbound message in an AI-driven chat needs a
  // response - not duplicates, not historical backfill, not our own outbound
  // sends, and not chats a human has taken over.
  const needsAiHandoff =
    result.message.wasInserted &&
    !message.fromMe &&
    message.isLive &&
    result.chat.aiMode === 'AI_ACTIVE' &&
    Boolean(result.message.textContent);

  if (needsAiHandoff) {
    const context = await gatherAiHandoffContext({
      businessId,
      chatId: result.chat.id,
      contactId: result.chat.contactId,
      queryText: result.message.textContent as string,
    });

    // Single-agent-per-business v1 scope - no agent-to-conversation routing
    // exists yet (see migration 022's own comment). No active agent
    // configured is a real, honest outcome: skip, don't fabricate a reply.
    const agent = await aiAgentRepository.findActiveForBusiness(businessId);
    if (!agent) {
      console.log(
        `[IncomingMessagesWorker] AI handoff for chat ${result.chat.id}: no active AI agent configured for business ${businessId}, skipping auto-reply.`,
      );
      return;
    }

    const reply = await generateAiReply(agent, context);
    if (reply.status !== 'generated') {
      console.log(`[IncomingMessagesWorker] AI reply unavailable for chat ${result.chat.id}: ${reply.reason}`);
      return;
    }

    // Idempotency key derived from the inbound message's own id: if this job
    // is ever retried/redelivered, the exact same reply is never sent twice.
    await whatsappOutboundMessageService.send({
      businessId,
      whatsappAccountId,
      chatId: result.chat.id,
      idempotencyKey: `ai-reply:${result.message.id}`,
      messageType: 'text',
      text: reply.text,
      requestedBy: 'ai',
    });
    console.log(`[IncomingMessagesWorker] AI reply queued for chat ${result.chat.id} (agent ${agent.id}).`);
  }
}

const messageRepository = new WhatsAppMessageRepository(pool);
const callRepository = new WhatsAppCallRepository(pool);
const syncJobRepository = new WhatsAppSyncJobRepository(pool);
const accountRepository = new WhatsAppAccountRepository(pool);
const statusRepository = new WhatsAppStatusRepository(pool);
const mediaRepository = new WhatsAppMediaRepository(pool);
const reactionRepository = new WhatsAppMessageReactionRepository(pool);
const presenceRepository = new WhatsAppPresenceRepository(pool);
const outboundMessageRepository = new WhatsAppOutboundMessageRepository(pool);
const aiAgentRepository = new AiAgentRepository(pool);

// Configurable, not hardcoded: operators can raise/lower this per deployment.
const MAX_MEDIA_DOWNLOAD_BYTES = Number(process.env.MEDIA_MAX_DOWNLOAD_BYTES ?? 100 * 1024 * 1024);

const MEDIA_CONTENT_KEYS = [
  'imageMessage',
  'videoMessage',
  'audioMessage',
  'documentMessage',
  'stickerMessage',
] as const;

/** Pulls the sender-declared plaintext SHA-256 off whichever media field is present, for real integrity verification against the bytes we actually downloaded. */
function extractDeclaredSha256(message: proto.IMessage): Buffer | null {
  for (const key of MEDIA_CONTENT_KEYS) {
    const content = message[key];
    if (content?.fileSha256) return Buffer.from(content.fileSha256);
  }
  return null;
}

interface HttpLikeError {
  status?: number;
  output?: { statusCode?: number };
}

/**
 * Downloads the real media bytes for a message via Baileys' own
 * downloadMediaMessage, verifies them, encrypts-at-rest, and records an
 * honest outcome - never a fabricated success. No `ctx` (reupload-request
 * callback) is passed: this worker has no live Baileys socket, so an
 * expired-media reupload isn't possible from here and is reported as
 * UNAVAILABLE rather than faked.
 */
async function processMediaDownload(data: MediaDownloadJobData): Promise<void> {
  const { businessId, mediaId, mediaDescriptor } = data;
  await mediaRepository.setDownloading(mediaId);

  const decoded = decodeBuffersFromQueue(mediaDescriptor) as { key: WAMessageKey; message: proto.IMessage };
  const waMessage = { key: decoded.key, message: decoded.message } as WAMessage;

  let buffer: Buffer;
  try {
    buffer = await downloadMediaMessage(waMessage, 'buffer', {});
  } catch (error) {
    const httpError = error as HttpLikeError;
    const statusCode = httpError.output?.statusCode ?? httpError.status;
    const unavailable = statusCode === 404 || statusCode === 410;
    console.error(
      `[RealtimeEventsWorker] Media download failed for media ${mediaId}: ${(error as Error).message}`,
    );
    await mediaRepository.setDownloadResult(mediaId, unavailable ? 'unavailable' : 'failed', null, null);
    return;
  }

  if (!buffer || buffer.length === 0) {
    console.error(`[RealtimeEventsWorker] Media download for ${mediaId} returned an empty buffer`);
    await mediaRepository.setDownloadResult(mediaId, 'failed', null, null);
    return;
  }

  if (buffer.length > MAX_MEDIA_DOWNLOAD_BYTES) {
    console.error(
      `[RealtimeEventsWorker] Media ${mediaId} (${buffer.length} bytes) exceeds MEDIA_MAX_DOWNLOAD_BYTES (${MAX_MEDIA_DOWNLOAD_BYTES})`,
    );
    await mediaRepository.setDownloadResult(mediaId, 'failed', null, null);
    return;
  }

  const actualSha256 = createHash('sha256').update(buffer).digest();
  const declaredSha256 = extractDeclaredSha256(decoded.message);
  if (declaredSha256 && !actualSha256.equals(declaredSha256)) {
    console.error(`[RealtimeEventsWorker] Media ${mediaId} failed checksum verification against sender-declared SHA-256`);
    await mediaRepository.setDownloadResult(mediaId, 'failed', null, null);
    return;
  }

  const sha256Hex = actualSha256.toString('hex');
  const storageReference = await storeMedia(businessId, sha256Hex, buffer);
  await mediaRepository.setDownloadResult(mediaId, 'downloaded', storageReference, sha256Hex, buffer.length);

  const media = await mediaRepository.findById(mediaId);
  if (media?.messageId) {
    const message = await messageRepository.findById(media.messageId);
    if (message) {
      await publishRealtimeEvent({ type: 'media.updated', businessId, mediaId, messageId: message.id, chatId: message.chatId });
    }
  } else if (media?.statusId) {
    await publishRealtimeEvent({ type: 'status.media.updated', businessId, mediaId, statusId: media.statusId });
  }
}

const STATUS_TTL_MS = 24 * 60 * 60 * 1000; // WhatsApp Status entries always expire 24h after posting - a real product rule, not a guess.

function mapContentTypeToStatusType(contentType: string): StatusType {
  if (contentType === 'text' || contentType === 'image' || contentType === 'video') return contentType;
  if (contentType === 'audio' || contentType === 'voice_note') return 'audio';
  return 'unknown';
}

function mapStatusTypeToMediaType(statusType: StatusType): MediaType | null {
  if (statusType === 'image' || statusType === 'video' || statusType === 'audio') return statusType;
  return null;
}

/**
 * Baileys has no dedicated status/stories event - status updates arrive as
 * ordinary messages.upsert events on the fixed status@broadcast JID. They
 * are routed here (never into whatsapp_messages/whatsapp_chats) into the
 * real whatsapp_statuses table. A media-bearing status gets the exact same
 * real download treatment as chat media (whatsapp_media row -> queued
 * download -> checksum-verified, encrypted-at-rest bytes) - only ever
 * queued once, on the genuinely new status insert, never re-queued for a
 * duplicate history-set replay of the same status_id.
 */
async function processStatusUpdate(data: StatusUpdateJobData): Promise<void> {
  const { businessId, whatsappAccountId, ingested } = data;
  const publisherJid = ingested.participant ?? ingested.remoteJid;
  const createdAt = ingested.messageTimestamp ?? ingested.ingestedAt;
  const statusType = mapContentTypeToStatusType(ingested.contentType);

  const status = await statusRepository.insert({
    businessId,
    whatsappAccountId,
    statusId: ingested.messageId,
    publisherJid,
    statusType,
    textContent: ingested.textPreview,
    expiresAt: new Date(new Date(createdAt).getTime() + STATUS_TTL_MS).toISOString(),
  });

  if (!status.wasInserted) return;

  const mediaType = mapStatusTypeToMediaType(statusType);
  if (mediaType && ingested.mediaDescriptor) {
    const media = await mediaRepository.insert({
      businessId,
      whatsappAccountId,
      statusId: status.id,
      mediaType,
      mimeType: ingested.mimetype,
      fileName: ingested.fileName,
    });
    await statusRepository.attachMedia(status.id, media.id);
    await enqueueMediaDownload({ businessId, whatsappAccountId, mediaId: media.id, mediaDescriptor: ingested.mediaDescriptor });
  }
}

async function processMessageStatus(data: MessageStatusJobData): Promise<void> {
  const { businessId, whatsappAccountId, whatsappMessageId, status } = data;
  const message = await messageRepository.findByWhatsAppId(businessId, whatsappAccountId, whatsappMessageId);
  if (!message) return; // The message hasn't been persisted yet (or ever will be, e.g. Sentinel-blocked) - nothing to update.

  await messageRepository.updateStatus(message.id, status);
  await publishRealtimeEvent({
    type: 'message.status',
    businessId,
    chatId: message.chatId,
    messageId: message.id,
    status,
  });
}

async function processCallEvent(data: CallEventJobData): Promise<void> {
  const { businessId, whatsappAccountId, event } = data;
  const status = mapBaileysCallStatus(event.status);
  if (!status) return; // Internal WebRTC signaling noise (transport/relaylatency) - no real state change to record.

  const remoteJid = event.chatId;
  const jidKind = classifyJid(remoteJid);
  const remotePhoneNumber = jidKind === 'group' ? null : derivePhoneNumber(remoteJid, jidKind, null);

  let startedAt: string | null = null;
  let acceptedAt: string | null = null;
  let endedAt: string | null = null;
  let durationSeconds: number | null = null;

  // event.date is a real Date object when the socket handler enqueues it,
  // but BullMQ round-trips job data through JSON - by the time this worker
  // (a separate process) reads it back, it has been serialized to a string.
  const eventDate = new Date(event.date).toISOString();

  if (status === 'offer') {
    startedAt = eventDate;
  } else if (status === 'accepted') {
    acceptedAt = eventDate;
  } else if (isTerminalCallStatus(status)) {
    endedAt = eventDate;
    // Duration is real talk time (accepted -> ended), never ring time. A
    // call that was never answered (missed/rejected/timeout) has no
    // duration - inventing one from ring time would misrepresent it.
    const existing = await callRepository.findByCallId(businessId, whatsappAccountId, event.id);
    if (existing?.acceptedAt) {
      durationSeconds = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(existing.acceptedAt).getTime()) / 1000));
    }
  }

  const call = await callRepository.upsertEvent({
    businessId,
    whatsappAccountId,
    callId: event.id,
    remoteJid,
    remotePhoneNumber,
    callType: callTypeFromEvent(event.isVideo),
    direction: 'inbound', // Baileys only ever reports calls placed to this account, never ones it places.
    status,
    isVideo: Boolean(event.isVideo),
    isGroup: Boolean(event.isGroup),
    startedAt,
    acceptedAt,
    endedAt,
    durationSeconds,
  });

  await publishRealtimeEvent({ type: 'call.updated', businessId, callId: call.id });
}

/**
 * Real reaction events - Baileys' own `messages.reaction` (a dedicated
 * event, not classified via messages.upsert). `reaction.text` empty/falsy
 * means the reactor removed their reaction (Baileys' own type-declaration
 * comment on the event confirms this convention) - the row is deleted,
 * never stored with a blank reaction. The dedicated whatsapp_message_reactions
 * table is authoritative; a reaction is never also inserted into
 * whatsapp_messages.
 */
async function processReaction(data: MessageReactionJobData): Promise<void> {
  const { businessId, whatsappAccountId, accountJid, targetWhatsappMessageId, reaction } = data;

  const message = await messageRepository.findByWhatsAppId(businessId, whatsappAccountId, targetWhatsappMessageId);
  if (!message) return; // Reaction to a message we never persisted (not yet arrived, or Sentinel-blocked) - nothing real to attach it to.

  const reactorKey = reaction.key;
  const reactorJid = reactorKey?.fromMe ? accountJid : (reactorKey?.participant ?? reactorKey?.remoteJid ?? null);
  if (!reactorJid) return; // No real identity to attribute the reaction to.

  const emoji = reaction.text;
  if (emoji) {
    await reactionRepository.upsert(businessId, whatsappAccountId, message.id, reactorJid, emoji);
  } else {
    await reactionRepository.remove(message.id, reactorJid);
  }

  await publishRealtimeEvent({ type: 'message.reaction', businessId, chatId: message.chatId, messageId: message.id });
}

/**
 * Real presence.update events only - WhatsApp's actual reported states
 * ('available'/'unavailable'/'composing'/'recording'/'paused'), never
 * inferred from whether our own socket happens to be connected.
 */
async function processPresenceUpdate(data: PresenceUpdateJobData): Promise<void> {
  const { businessId, whatsappAccountId, contactJid, presence } = data;
  const lastSeenAt = presence.lastSeen ? new Date(presence.lastSeen * 1000).toISOString() : null;

  await presenceRepository.record(businessId, whatsappAccountId, contactJid, presence.lastKnownPresence, lastSeenAt);
  await publishRealtimeEvent({ type: 'presence.updated', businessId, contactJid });
}

// Documented rule: WhatsApp's own client rings for roughly 45-60s before a
// call goes to "missed" on the device. A call still sitting in offer/ringing
// well past that, with no further event ever arriving from Baileys, is
// reconciled to 'timeout' rather than left stuck forever.
const CALL_RING_TIMEOUT_SECONDS = 60;
const CALL_TIMEOUT_SWEEP_INTERVAL_MS = 30_000;

export async function sweepStaleRingingCalls(): Promise<void> {
  const stale = await callRepository.findStaleRingingCalls(CALL_RING_TIMEOUT_SECONDS);
  for (const call of stale) {
    const updated = await callRepository.upsertEvent({
      businessId: call.businessId,
      whatsappAccountId: call.whatsappAccountId,
      callId: call.callId,
      remoteJid: call.remoteJid,
      remotePhoneNumber: call.remotePhoneNumber,
      callType: call.callType,
      direction: call.direction,
      status: 'timeout',
      isVideo: call.isVideo,
      isGroup: call.isGroup,
      endedAt: new Date().toISOString(),
    });
    await publishRealtimeEvent({ type: 'call.updated', businessId: call.businessId, callId: updated.id });
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale ringing call(s) to timeout`);
  }
}

// Documented rule: incrementCounts() bumps updated_at on every real batch of
// sync progress. A 'running' job with no progress in this long has no
// process left driving it - WhatsApp will never send it a completion signal
// on its own - reconciled to 'failed' (never 'completed'/'partial', which
// would falsely claim the sync actually finished) rather than left silently
// claiming to be in-progress forever.
const SYNC_JOB_STALE_SECONDS = 600;
const SYNC_JOB_TIMEOUT_SWEEP_INTERVAL_MS = 120_000;

export async function sweepStaleSyncJobs(): Promise<void> {
  const stale = await syncJobRepository.findStaleRunning(SYNC_JOB_STALE_SECONDS);
  for (const job of stale) {
    await syncJobRepository.markFailed(
      job.id,
      `Abandoned mid-sync - no progress for over ${SYNC_JOB_STALE_SECONDS}s (likely a process restart or crash), reconciled by the stale-job sweep`,
    );
    // Setting the account back off 'in_progress' is what lets the next
    // real reconnect retry the sync instead of the gate in
    // persistConnectedAccount() silently skipping it forever.
    await accountRepository.markSyncFailed(
      job.whatsappAccountId,
      'Sync job abandoned mid-run - will retry automatically on next reconnect',
    );
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale running sync job(s) to failed`);
  }
}

// A row wedged in 'queued'/'sending' with no BullMQ retry left to resolve it
// (worker crashed mid-dispatch, process killed between markSending and the
// actual sendMessage call) - the same honesty problem the call/sync-job
// sweeps exist for, reconciled the same way: never left silently claiming
// to be in-flight forever.
const OUTBOUND_MESSAGE_STALE_SECONDS = 300;
const OUTBOUND_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS = 60_000;

export async function sweepStaleOutboundMessages(): Promise<void> {
  const stale = await outboundMessageRepository.findStalePending(OUTBOUND_MESSAGE_STALE_SECONDS);
  for (const record of stale) {
    await outboundMessageRepository.markFailed(
      record.id,
      `Abandoned mid-send - no progress for over ${OUTBOUND_MESSAGE_STALE_SECONDS}s (likely a process restart or crash), reconciled by the stale-message sweep`,
    );
  }
  if (stale.length > 0) {
    console.log(`[RealtimeEventsWorker] Reconciled ${stale.length} stale outbound message(s) to failed`);
  }
}

async function processRealtimeEventJob(
  job: Job<
    | MessageStatusJobData
    | CallEventJobData
    | StatusUpdateJobData
    | MediaDownloadJobData
    | MessageReactionJobData
    | PresenceUpdateJobData
  >,
): Promise<void> {
  if (job.name === 'message-status') {
    await processMessageStatus(job.data as MessageStatusJobData);
  } else if (job.name === 'call-event') {
    await processCallEvent(job.data as CallEventJobData);
  } else if (job.name === 'status-update') {
    await processStatusUpdate(job.data as StatusUpdateJobData);
  } else if (job.name === 'call-timeout-sweep') {
    await sweepStaleRingingCalls();
  } else if (job.name === 'sync-job-timeout-sweep') {
    await sweepStaleSyncJobs();
  } else if (job.name === 'outbound-message-timeout-sweep') {
    await sweepStaleOutboundMessages();
  } else if (job.name === 'media-download') {
    await processMediaDownload(job.data as MediaDownloadJobData);
  } else if (job.name === 'message-reaction') {
    await processReaction(job.data as MessageReactionJobData);
  } else if (job.name === 'presence-update') {
    await processPresenceUpdate(job.data as PresenceUpdateJobData);
  }
}

const CONCURRENCY = Number(process.env.INCOMING_MESSAGES_WORKER_CONCURRENCY ?? 5);

export const incomingMessagesWorker = new Worker<IncomingMessageJobData>(INCOMING_MESSAGES_QUEUE, processJob, {
  connection: queueConnection,
  concurrency: CONCURRENCY,
});

export const realtimeEventsWorker = new Worker(REALTIME_EVENTS_QUEUE, processRealtimeEventJob, {
  connection: queueConnection,
  concurrency: CONCURRENCY,
});

incomingMessagesWorker.on('completed', (job) => {
  console.log(`[IncomingMessagesWorker] Persisted message ${job.data.message.messageId}`);
});

incomingMessagesWorker.on('failed', (job, error) => {
  console.error(`[IncomingMessagesWorker] Failed to persist message ${job?.data.message.messageId}:`, error.message);
});

incomingMessagesWorker.on('error', (error) => {
  console.error('[IncomingMessagesWorker] Worker error:', error.message);
});

realtimeEventsWorker.on('failed', (job, error) => {
  console.error(`[RealtimeEventsWorker] Failed job "${job?.name}":`, error.message);
});

realtimeEventsWorker.on('error', (error) => {
  console.error('[RealtimeEventsWorker] Worker error:', error.message);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`[IncomingMessagesWorker] Received ${signal}, closing workers...`);
  await Promise.all([incomingMessagesWorker.close(), realtimeEventsWorker.close()]);
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

console.log(`[IncomingMessagesWorker] Listening on queue "${INCOMING_MESSAGES_QUEUE}" (concurrency=${CONCURRENCY})`);
console.log(`[RealtimeEventsWorker] Listening on queue "${REALTIME_EVENTS_QUEUE}" (concurrency=${CONCURRENCY})`);

// upsertJobScheduler is idempotent by scheduler id, so re-registering this on
// every worker restart is safe and never creates duplicate schedules.
void realtimeEventsQueue
  .upsertJobScheduler('call-timeout-sweep', { every: CALL_TIMEOUT_SWEEP_INTERVAL_MS }, { name: 'call-timeout-sweep' })
  .then(() => console.log(`[RealtimeEventsWorker] Scheduled call-timeout-sweep every ${CALL_TIMEOUT_SWEEP_INTERVAL_MS}ms`))
  .catch((error: Error) => console.error('[RealtimeEventsWorker] Failed to schedule call-timeout-sweep:', error.message));

void realtimeEventsQueue
  .upsertJobScheduler(
    'sync-job-timeout-sweep',
    { every: SYNC_JOB_TIMEOUT_SWEEP_INTERVAL_MS },
    { name: 'sync-job-timeout-sweep' },
  )
  .then(() =>
    console.log(`[RealtimeEventsWorker] Scheduled sync-job-timeout-sweep every ${SYNC_JOB_TIMEOUT_SWEEP_INTERVAL_MS}ms`),
  )
  .catch((error: Error) =>
    console.error('[RealtimeEventsWorker] Failed to schedule sync-job-timeout-sweep:', error.message),
  );

void realtimeEventsQueue
  .upsertJobScheduler(
    'outbound-message-timeout-sweep',
    { every: OUTBOUND_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS },
    { name: 'outbound-message-timeout-sweep' },
  )
  .then(() =>
    console.log(
      `[RealtimeEventsWorker] Scheduled outbound-message-timeout-sweep every ${OUTBOUND_MESSAGE_TIMEOUT_SWEEP_INTERVAL_MS}ms`,
    ),
  )
  .catch((error: Error) =>
    console.error('[RealtimeEventsWorker] Failed to schedule outbound-message-timeout-sweep:', error.message),
  );
