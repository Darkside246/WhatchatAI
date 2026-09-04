import { Queue, Worker } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * AURA engineering directive, "Minimal control test" (2026-09-04): isolates
 * whether the raw Redis/BullMQ environment itself is slow to close a
 * queue+worker pair, independent of anything Aura's own workers do (14
 * repeatable job schedulers, a Postgres pool, dozens of event listeners).
 * A brand-new Queue/Worker pair here, with nothing else registered against
 * them, is the simplest possible thing that can still exercise the same
 * "create -> process -> close" lifecycle the real integration tests hang
 * on. If THIS closes fast, the slowness is specific to Aura's worker
 * module, not the underlying infra - a fact, not a guess.
 */
describe('BullMQ control test (bare queue + worker, no Aura code)', () => {
  const queue = new Queue('control-test-queue', { connection: { host: '127.0.0.1', port: 6379, db: 1 } });
  const worker = new Worker(
    'control-test-queue',
    async (job) => {
      return job.data;
    },
    { connection: { host: '127.0.0.1', port: 6379, db: 1 }, concurrency: 1 },
  );

  afterAll(async () => {
    const start = Date.now();
    await worker.close();
    await queue.close();
    console.log(`[control test] close() took ${Date.now() - start}ms`);
  });

  it('processes one job and completes deterministically', async () => {
    await worker.waitUntilReady();
    await queue.waitUntilReady();

    const completed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('control test job never completed')), 10_000);
      worker.on('completed', function onCompleted(job) {
        if (job.data.marker !== 'control-marker') return;
        clearTimeout(timeout);
        worker.off('completed', onCompleted);
        resolve();
      });
    });

    await queue.add('control-job', { marker: 'control-marker' });
    await completed;
    expect(true).toBe(true);
  });
});
