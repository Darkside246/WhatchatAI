import { Queue } from 'bullmq';
import { queueConnection, attachQueueErrorLogging } from '../connection.js';

export const FUNNEL_ADVANCE_QUEUE = 'funnel_advance';

export interface FunnelAdvanceJobData {
  instanceId: string;
}

export const funnelAdvanceQueue = new Queue<FunnelAdvanceJobData>(FUNNEL_ADVANCE_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 2000 },
  },
});
attachQueueErrorLogging(funnelAdvanceQueue, 'funnelAdvanceQueue');

/** Real BullMQ delay - a WAIT node's "wait N minutes" is genuinely paused time, not a fabricated status. */
export function enqueueFunnelAdvance(data: FunnelAdvanceJobData, delayMs = 0): Promise<unknown> {
  return funnelAdvanceQueue.add('advance', data, delayMs > 0 ? { delay: delayMs } : {});
}
