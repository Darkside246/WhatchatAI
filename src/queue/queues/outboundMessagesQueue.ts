import { Queue } from 'bullmq';
import { queueConnection, attachQueueErrorLogging } from '../connection.js';

export const OUTBOUND_MESSAGES_QUEUE = 'outbound_messages';

export interface OutboundMessageJobData {
  outboundMessageId: string;
}

/**
 * A dedicated worker (registered in incomingMessagesWorker.ts, the project's
 * one worker process) drains this and calls the real Baileys sendMessage.
 * Retries are BullMQ's own attempts/backoff - a transient failure (socket
 * momentarily reconnecting, brief network blip) gets retried automatically;
 * the outbound row's own status only ever reflects a real outcome, never a
 * fabricated one, once attempts are exhausted (see markFailed in the worker).
 */
export const outboundMessagesQueue = new Queue<OutboundMessageJobData>(OUTBOUND_MESSAGES_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});
attachQueueErrorLogging(outboundMessagesQueue, 'outboundMessagesQueue');

/**
 * delayMs staggers dispatch (real BullMQ job delay, not a blocking
 * server-side sleep) - used by campaign sends so recipients aren't all
 * messaged in the same instant, never by a normal 1:1 composer send.
 */
export function enqueueOutboundMessage(data: OutboundMessageJobData, delayMs?: number): Promise<unknown> {
  return outboundMessagesQueue.add('send', data, delayMs ? { delay: delayMs } : {});
}
