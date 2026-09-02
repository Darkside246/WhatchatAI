import type { Queue } from 'bullmq';
import { documentParseQueue } from './queues/documentParseQueue.js';
import { emailSendQueue } from './queues/emailSendQueue.js';
import { funnelAdvanceQueue } from './queues/funnelAdvanceQueue.js';
import { incomingMessagesQueue } from './queues/incomingMessagesQueue.js';
import { messageRevocationsQueue } from './queues/messageRevocationsQueue.js';
import { outboundMessagesQueue } from './queues/outboundMessagesQueue.js';
import { realtimeEventsQueue } from './queues/realtimeEventsQueue.js';
import { scheduledStatusesQueue } from './queues/scheduledStatusesQueue.js';

const MONITORED_QUEUES: Queue[] = [
  documentParseQueue,
  emailSendQueue,
  funnelAdvanceQueue,
  incomingMessagesQueue,
  messageRevocationsQueue,
  outboundMessagesQueue,
  realtimeEventsQueue,
  scheduledStatusesQueue,
];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** A queue with jobs piled up this deep is a real "background work is silently not happening" signal, not just a busy moment. Env-overridable, same pattern as agentGuard.ts's rate limits. */
function getFailedThreshold(): number {
  return envInt('QUEUE_HEALTH_FAILED_THRESHOLD', 20);
}
function getWaitingThreshold(): number {
  return envInt('QUEUE_HEALTH_WAITING_THRESHOLD', 500);
}

export interface QueueHealthEntry {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  healthy: boolean;
}

export interface QueueHealthSummary {
  healthy: boolean;
  queues: QueueHealthEntry[];
}

/**
 * Real BullMQ job counts per queue (waiting/active/completed/failed/delayed
 * via getJobCounts) - the actual background-processing stack this app runs
 * on Redis/Fly.io, not the Celery-on-DigitalOcean guardrails a template
 * report assumed. A queue counts unhealthy once its failed or waiting
 * count crosses a real, env-overridable threshold - never a fabricated
 * "all good" just because the Redis connection itself is up.
 */
export async function checkQueueHealth(): Promise<QueueHealthSummary> {
  const failedThreshold = getFailedThreshold();
  const waitingThreshold = getWaitingThreshold();

  const queues = await Promise.all(
    MONITORED_QUEUES.map(async (queue): Promise<QueueHealthEntry> => {
      try {
        const counts = await queue.getJobCounts('waiting', 'active', 'completed', 'failed', 'delayed');
        const waiting = counts.waiting ?? 0;
        const active = counts.active ?? 0;
        const completed = counts.completed ?? 0;
        const failed = counts.failed ?? 0;
        const delayed = counts.delayed ?? 0;
        return {
          name: queue.name,
          waiting,
          active,
          completed,
          failed,
          delayed,
          healthy: failed < failedThreshold && waiting < waitingThreshold,
        };
      } catch (error) {
        // A queue we cannot even reach is unhealthy by definition, not
        // silently omitted from the report.
        return {
          name: queue.name,
          waiting: 0,
          active: 0,
          completed: 0,
          failed: 0,
          delayed: 0,
          healthy: false,
        };
      }
    }),
  );

  return { healthy: queues.every((entry) => entry.healthy), queues };
}
