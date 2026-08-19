import { Redis } from 'ioredis';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** Shared client for caching and rate-limiting. BullMQ queues/workers use their own dedicated connections (see src/queue/connection.ts) per BullMQ's own requirements. */
export const redisClient = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

redisClient.on('error', (error: Error) => {
  console.error('[Redis] Connection error:', error.message);
});

export interface RedisHealth {
  available: boolean;
  error: string | null;
}

export async function checkRedisHealth(): Promise<RedisHealth> {
  try {
    const pong = await redisClient.ping();
    return { available: pong === 'PONG', error: null };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}
