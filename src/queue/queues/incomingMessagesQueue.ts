import { Queue } from 'bullmq';
import { queueConnection } from '../connection.js';
import type { IngestedWhatsAppMessage } from '../../services/whatsappMessageIngestionService.js';

export const INCOMING_MESSAGES_QUEUE = 'incoming_messages';

export interface IncomingMessageJobData {
  businessId: string;
  whatsappAccountId: string;
  accountJid: string;
  message: IngestedWhatsAppMessage;
}

/**
 * Speed layer entry point: the Baileys `messages.upsert` handler pushes here
 * instead of writing to Postgres synchronously. A dedicated worker process
 * (src/queue/workers/incomingMessagesWorker.ts) drains this queue and does
 * the real (Sentinel-gated) persistence off the WebSocket event loop.
 */
export const incomingMessagesQueue = new Queue<IncomingMessageJobData>(INCOMING_MESSAGES_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

/**
 * Enqueues a single ingested message without blocking the caller on a DB
 * write. Callers should not await this from a hot event-loop path; the
 * returned promise resolves once the job is durably queued in Redis (a
 * single fast round trip), not once it's processed.
 */
export function enqueueIncomingMessage(data: IncomingMessageJobData): Promise<unknown> {
  return incomingMessagesQueue.add('ingest', data);
}
