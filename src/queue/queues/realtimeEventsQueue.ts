import { Queue } from 'bullmq';
import { queueConnection } from '../connection.js';
import type { MessageStatus } from '../../domain/whatsapp/types.js';
import type { WACallEvent } from '@whiskeysockets/baileys';

export const REALTIME_EVENTS_QUEUE = 'realtime_events';

export interface MessageStatusJobData {
  businessId: string;
  whatsappAccountId: string;
  whatsappMessageId: string;
  status: MessageStatus;
}

export interface CallEventJobData {
  businessId: string;
  whatsappAccountId: string;
  event: WACallEvent;
}

/**
 * Lightweight, non-Sentinel-gated background jobs: delivery-receipt status
 * updates and call events. Kept off the Baileys event loop for the same
 * reason as incoming_messages (no synchronous DB write on that turn), but
 * separate from that queue since these never carry new message content that
 * needs security screening.
 */
export const realtimeEventsQueue = new Queue(REALTIME_EVENTS_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 5000 },
  },
});

export function enqueueMessageStatus(data: MessageStatusJobData): Promise<unknown> {
  return realtimeEventsQueue.add('message-status', data);
}

export function enqueueCallEvent(data: CallEventJobData): Promise<unknown> {
  return realtimeEventsQueue.add('call-event', data);
}
