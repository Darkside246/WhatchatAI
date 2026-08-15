import { Worker, type Job } from 'bullmq';
import { queueConnection } from '../connection.js';
import { INCOMING_MESSAGES_QUEUE, type IncomingMessageJobData } from '../queues/incomingMessagesQueue.js';
import {
  REALTIME_EVENTS_QUEUE,
  type MessageStatusJobData,
  type CallEventJobData,
} from '../queues/realtimeEventsQueue.js';
import { whatsappMessagePersistenceService } from '../../services/whatsappMessagePersistenceService.js';
import { runSentinel } from '../../security/sentinel/sentinel.js';
import { gatherAiHandoffContext } from '../../services/aiContextGathererService.js';
import { publishRealtimeEvent } from '../../realtime/pubsub.js';
import { pool } from '../../db/pool.js';
import { WhatsAppMessageRepository } from '../../repositories/whatsappMessageRepository.js';
import { WhatsAppCallRepository } from '../../repositories/whatsappCallRepository.js';
import { mapBaileysCallStatus, callTypeFromEvent, isTerminalCallStatus } from '../../domain/whatsapp/callStatus.js';
import { classifyJid, derivePhoneNumber } from '../../domain/whatsapp/jid.js';

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

    // Gemini Orchestrator wiring (turning this context into an actual AI
    // reply) is a separate, not-yet-built phase. This log line is the real,
    // observable hand-off point until that exists.
    console.log(
      `[IncomingMessagesWorker] AI handoff ready for chat ${result.chat.id}: ` +
        `crmContact=${context.crmContact ? 'found' : 'none'}, ` +
        `knowledgeBase=${context.knowledgeBase.available ? `${context.knowledgeBase.results.length} results` : 'unavailable'}, ` +
        `historyMessages=${context.conversationHistory.length}`,
    );
  }
}

const messageRepository = new WhatsAppMessageRepository(pool);
const callRepository = new WhatsAppCallRepository(pool);

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
  let endedAt: string | null = null;
  let durationSeconds: number | null = null;

  // event.date is a real Date object when the socket handler enqueues it,
  // but BullMQ round-trips job data through JSON - by the time this worker
  // (a separate process) reads it back, it has been serialized to a string.
  const eventDate = new Date(event.date).toISOString();

  if (status === 'offer') {
    startedAt = eventDate;
  } else if (isTerminalCallStatus(status)) {
    endedAt = eventDate;
    const existing = await callRepository.findByCallId(businessId, whatsappAccountId, event.id);
    if (existing?.startedAt) {
      durationSeconds = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(existing.startedAt).getTime()) / 1000));
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
    endedAt,
    durationSeconds,
  });

  await publishRealtimeEvent({ type: 'call.updated', businessId, callId: call.id });
}

async function processRealtimeEventJob(job: Job<MessageStatusJobData | CallEventJobData>): Promise<void> {
  if (job.name === 'message-status') {
    await processMessageStatus(job.data as MessageStatusJobData);
  } else if (job.name === 'call-event') {
    await processCallEvent(job.data as CallEventJobData);
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
