import { Queue } from 'bullmq';
import { queueConnection } from '../connection.js';

export const MESSAGE_REVOCATIONS_QUEUE = 'message_revocations';

/** Revokes one of our own chat messages (also the unit a campaign recall is made of). */
export interface MessageRevocationJobData {
  kind: 'message';
  /** Our own whatsapp_messages row id - the worker re-reads it rather than trusting job payload. */
  messageId: string;
  businessId: string;
  whatsappAccountId: string;
}

/** Recalls a published WhatsApp Status post. */
export interface StatusRevocationJobData {
  kind: 'status';
  scheduledStatusId: string;
  businessId: string;
  whatsappAccountId: string;
}

export type RevocationJobData = MessageRevocationJobData | StatusRevocationJobData;

export const messageRevocationsQueue = new Queue<RevocationJobData>(MESSAGE_REVOCATIONS_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 3000 },
    removeOnComplete: 500,
    removeOnFail: 500,
  },
});

export async function enqueueRevocation(data: RevocationJobData, delayMs = 0): Promise<void> {
  await messageRevocationsQueue.add(`revoke-${data.kind}`, data, delayMs > 0 ? { delay: delayMs } : undefined);
}
