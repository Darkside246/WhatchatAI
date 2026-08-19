import type { ConnectionOptions } from 'bullmq';

const redisUrl = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');

/** BullMQ requires maxRetriesPerRequest: null on its own dedicated connection - it manages retries itself. */
export const queueConnection: ConnectionOptions = {
  host: redisUrl.hostname,
  port: Number(redisUrl.port || 6379),
  password: redisUrl.password || undefined,
  maxRetriesPerRequest: null,
};
