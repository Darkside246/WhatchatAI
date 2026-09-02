import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkQueueHealth } from '../src/queue/queueHealth.js';
import { documentParseQueue } from '../src/queue/queues/documentParseQueue.js';
import { emailSendQueue } from '../src/queue/queues/emailSendQueue.js';
import { funnelAdvanceQueue } from '../src/queue/queues/funnelAdvanceQueue.js';
import { incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { messageRevocationsQueue } from '../src/queue/queues/messageRevocationsQueue.js';
import { outboundMessagesQueue } from '../src/queue/queues/outboundMessagesQueue.js';
import { realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { scheduledStatusesQueue } from '../src/queue/queues/scheduledStatusesQueue.js';

const ALL_QUEUES = [
  documentParseQueue,
  emailSendQueue,
  funnelAdvanceQueue,
  incomingMessagesQueue,
  messageRevocationsQueue,
  outboundMessagesQueue,
  realtimeEventsQueue,
  scheduledStatusesQueue,
];

/**
 * Real BullMQ + real Redis (no mocks) - jobs added here sit in 'waiting'
 * since no worker is running in this test process to drain them, which is
 * exactly the state this file needs to exercise the waiting-threshold path
 * without needing a job to actually fail. Unlike Postgres, this shared
 * Redis instance isn't reset by resetDatabase() between test files this
 * session, so every queue is drained before each test here rather than
 * assuming a clean starting backlog.
 */
describe('checkQueueHealth (real BullMQ job counts against real Redis)', () => {
  async function cleanAllQueues(): Promise<void> {
    await Promise.all(
      ALL_QUEUES.map(async (queue) => {
        await queue.drain();
        await queue.clean(0, 10_000, 'failed');
        await queue.clean(0, 10_000, 'completed');
      }),
    );
  }

  beforeEach(cleanAllQueues);

  afterEach(async () => {
    delete process.env.QUEUE_HEALTH_WAITING_THRESHOLD;
    delete process.env.QUEUE_HEALTH_FAILED_THRESHOLD;
    await cleanAllQueues();
  });

  it('reports all eight real queues, each healthy under an empty/near-empty backlog', async () => {
    const summary = await checkQueueHealth();
    expect(summary.queues.map((q) => q.name).sort()).toEqual([
      'document_parse',
      'email_send',
      'funnel_advance',
      'incoming_messages',
      'message_revocations',
      'outbound_messages',
      'realtime_events',
      'scheduled_statuses',
    ]);
    expect(summary.healthy).toBe(true);
    for (const queue of summary.queues) {
      expect(queue.healthy).toBe(true);
      expect(queue.failed).toBeLessThan(20);
    }
  });

  it('flags a real queue unhealthy once its waiting count crosses the (env-overridable) threshold', async () => {
    process.env.QUEUE_HEALTH_WAITING_THRESHOLD = '2';
    await documentParseQueue.addBulk([
      { name: 'test-job', data: { documentId: 'doc-1', businessId: 'business-1' } },
      { name: 'test-job', data: { documentId: 'doc-2', businessId: 'business-1' } },
      { name: 'test-job', data: { documentId: 'doc-3', businessId: 'business-1' } },
    ]);

    const summary = await checkQueueHealth();
    const documentParse = summary.queues.find((q) => q.name === 'document_parse');
    expect(documentParse?.waiting).toBeGreaterThanOrEqual(3);
    expect(documentParse?.healthy).toBe(false);
    expect(summary.healthy).toBe(false);

    // Every other queue is untouched and still healthy - one queue's real
    // backlog never makes the whole summary lie about the others.
    const others = summary.queues.filter((q) => q.name !== 'document_parse');
    expect(others.every((q) => q.healthy)).toBe(true);
  });
});
