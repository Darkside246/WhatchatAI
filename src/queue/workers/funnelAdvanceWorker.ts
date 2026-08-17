import { Worker, type Job } from 'bullmq';
import { queueConnection } from '../connection.js';
import { FUNNEL_ADVANCE_QUEUE, type FunnelAdvanceJobData } from '../queues/funnelAdvanceQueue.js';
import { resumeFunnelInstance } from '../../services/funnelService.js';

/**
 * Resumes a WAIT-paused funnel instance for real, once its real delay has
 * elapsed. Runs in the API server process (same as the outbound/status
 * workers) since resuming may itself need to send a real WhatsApp message.
 */
async function processFunnelAdvance(job: Job<FunnelAdvanceJobData>): Promise<void> {
  await resumeFunnelInstance(job.data.instanceId);
}

const FUNNEL_ADVANCE_CONCURRENCY = Number(process.env.FUNNEL_ADVANCE_WORKER_CONCURRENCY ?? 2);

export const funnelAdvanceWorker = new Worker<FunnelAdvanceJobData>(FUNNEL_ADVANCE_QUEUE, processFunnelAdvance, {
  connection: queueConnection,
  concurrency: FUNNEL_ADVANCE_CONCURRENCY,
});

funnelAdvanceWorker.on('failed', (job, error) => {
  console.error(`[FunnelAdvanceWorker] Attempt failed for ${job?.data.instanceId}:`, error.message);
});

funnelAdvanceWorker.on('error', (error) => {
  console.error('[FunnelAdvanceWorker] Worker error:', error.message);
});

console.log(`[FunnelAdvanceWorker] Listening on queue "${FUNNEL_ADVANCE_QUEUE}" (concurrency=${FUNNEL_ADVANCE_CONCURRENCY})`);
