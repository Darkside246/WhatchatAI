import { Redis } from 'ioredis';
import { redisClient } from '../redis/client.js';

export const REALTIME_CHANNEL = 'whatchatai:realtime';

export type RealtimeEvent =
  | { type: 'message.new'; businessId: string; chatId: string }
  | { type: 'chat.updated'; businessId: string; chatId: string }
  | { type: 'message.status'; businessId: string; chatId: string; messageId: string; status: string }
  | { type: 'call.updated'; businessId: string; callId: string };

/**
 * Cross-process event bridge: the BullMQ worker process (which actually
 * persists messages, statuses, and calls) publishes here; the API server
 * process subscribes (see subscribeToRealtimeEvents) and forwards to
 * connected WebSocket clients. A plain ioredis PUBLISH doesn't need a
 * dedicated connection, so the shared cache/rate-limit client is reused.
 */
export async function publishRealtimeEvent(event: RealtimeEvent): Promise<void> {
  await redisClient.publish(REALTIME_CHANNEL, JSON.stringify(event));
}

/**
 * Subscribing puts a Redis connection into subscriber mode, where it can no
 * longer run other commands - this always needs its own dedicated
 * connection, separate from the shared cache/rate-limit client.
 */
export function subscribeToRealtimeEvents(onEvent: (event: RealtimeEvent) => void): () => void {
  const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const subscriber = new Redis(redisUrl, { maxRetriesPerRequest: null });

  subscriber.on('error', (error: Error) => {
    console.error('[Realtime] Redis subscriber error:', error.message);
  });

  void subscriber.subscribe(REALTIME_CHANNEL).catch((error: Error) => {
    console.error('[Realtime] Failed to subscribe:', error.message);
  });

  subscriber.on('message', (_channel: string, message: string) => {
    try {
      onEvent(JSON.parse(message) as RealtimeEvent);
    } catch (error) {
      console.error('[Realtime] Failed to parse event:', error);
    }
  });

  return () => void subscriber.quit();
}
