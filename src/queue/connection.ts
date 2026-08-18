import type { ConnectionOptions } from 'bullmq';

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
