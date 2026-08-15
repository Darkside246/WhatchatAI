import { Worker, type Job } from 'bullmq';
import { queueConnection } from '../connection.js';
import { INCOMING_MESSAGES_QUEUE, type IncomingMessageJobData } from '../queues/incomingMessagesQueue.js';
import { whatsappMessagePersistenceService } from '../../services/whatsappMessagePersistenceService.js';
import { runSentinel } from '../../security/sentinel/sentinel.js';
import { gatherAiHandoffContext } from '../../services/aiContextGathererService.js';

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

const CONCURRENCY = Number(process.env.INCOMING_MESSAGES_WORKER_CONCURRENCY ?? 5);

export const incomingMessagesWorker = new Worker<IncomingMessageJobData>(INCOMING_MESSAGES_QUEUE, processJob, {
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

async function shutdown(signal: string): Promise<void> {
  console.log(`[IncomingMessagesWorker] Received ${signal}, closing worker...`);
  await incomingMessagesWorker.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

console.log(`[IncomingMessagesWorker] Listening on queue "${INCOMING_MESSAGES_QUEUE}" (concurrency=${CONCURRENCY})`);
