import { afterEach, describe, expect, it } from 'vitest';
import { publishRealtimeEvent, subscribeToRealtimeEvents, type RealtimeEvent } from '../src/realtime/pubsub.js';

describe('realtime pub/sub bridge (real Redis PUBLISH/SUBSCRIBE)', () => {
  let unsubscribe: (() => void) | null = null;

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
  });

  it('delivers a published event to a real subscriber', async () => {
    const received: RealtimeEvent[] = [];
    const delivery = new Promise<void>((resolve) => {
      unsubscribe = subscribeToRealtimeEvents((event) => {
        received.push(event);
        resolve();
      });
    });

    // Give the real Redis SUBSCRIBE a moment to actually register before publishing.
    await new Promise((resolve) => setTimeout(resolve, 200));

    await publishRealtimeEvent({ type: 'chat.updated', businessId: 'biz-1', chatId: 'chat-1' });
    await delivery;

    expect(received).toEqual([{ type: 'chat.updated', businessId: 'biz-1', chatId: 'chat-1' }]);
  });
});
