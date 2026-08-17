import { Queue } from 'bullmq';
import { queueConnection } from '../connection.js';

export const SCHEDULED_STATUSES_QUEUE = 'scheduled_statuses';

export interface ScheduledStatusJobData {
  scheduledStatusId: string;
}

export const scheduledStatusesQueue = new Queue<ScheduledStatusJobData>(SCHEDULED_STATUSES_QUEUE, {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 500 },
    removeOnFail: { count: 2000 },
  },
});

/** delayMs is real time-until-publish (scheduledAt - now), a genuine BullMQ delayed job, never a fabricated "Scheduled" label with nothing behind it. */
export function enqueueScheduledStatus(data: ScheduledStatusJobData, delayMs: number): Promise<unknown> {
  return scheduledStatusesQueue.add('publish', data, { delay: Math.max(0, delayMs) });
}
