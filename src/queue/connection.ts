import type { ConnectionOptions, Queue } from 'bullmq';

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

/**
 * Redis database index, taken from the URL path (redis://host:port/2).
 *
 * This matters for more than tidiness: BullMQ queues live in the Redis
 * keyspace, so anything sharing an index shares the queues. A running
 * `npm run dev` on the same index will happily consume the test suite's
 * jobs, which shows up as tests that fail for no reason and pass on a
 * re-run. Tests therefore get their own index (see vitest.config.ts).
 */
const databaseIndex = Number(redisUrl.pathname.replace('/', '')) || 0;

/** BullMQ requires maxRetriesPerRequest: null on its own dedicated connection - it manages retries itself. */
export const queueConnection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
  db: databaseIndex,
  maxRetriesPerRequest: null,
};

/** Exposed so the test bootstrap can assert it is genuinely isolated from a dev instance. */
export const queueDatabaseIndex = databaseIndex;

/**
 * Every BullMQ `Queue` (the producer side - `.add()` callers, not the
 * `Worker`s that already handle this) is a real EventEmitter that BullMQ's
 * own internals wire straight to its Redis connection: `QueueBase`
 * forwards the connection's own `'error'` events (redis-restart,
 * network blip, timeout - all routine in production) via
 * `this.backend.on('error', (error) => this.emit('error', error))`.
 * With zero listeners, Node's default behavior for an unlistened
 * `'error'` event is to throw - synchronously, outside any awaited call
 * stack, the same shape as the stream-pipe bug crashSafety.ts guards
 * against, just far more likely to actually fire. Every `Worker` in this
 * codebase already has its own `.on('error', ...)`; only the `Queue`
 * producer instances were missed. Call this once per Queue, right after
 * construction.
 */
export function attachQueueErrorLogging(queue: Queue, label: string): void {
  queue.on('error', (error) => {
    console.error(`[${label}] Redis connection error:`, error.message);
  });
}
