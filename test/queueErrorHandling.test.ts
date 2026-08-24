import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { incomingMessagesQueue } from '../src/queue/queues/incomingMessagesQueue.js';
import { outboundMessagesQueue } from '../src/queue/queues/outboundMessagesQueue.js';
import { documentParseQueue } from '../src/queue/queues/documentParseQueue.js';
import { emailSendQueue } from '../src/queue/queues/emailSendQueue.js';
import { funnelAdvanceQueue } from '../src/queue/queues/funnelAdvanceQueue.js';
import { messageRevocationsQueue } from '../src/queue/queues/messageRevocationsQueue.js';
import { realtimeEventsQueue } from '../src/queue/queues/realtimeEventsQueue.js';
import { scheduledStatusesQueue } from '../src/queue/queues/scheduledStatusesQueue.js';

/**
 * Background crash-safety sweep (see src/queue/connection.ts's
 * attachQueueErrorLogging doc comment): every BullMQ `Queue` producer
 * instance is a real EventEmitter that BullMQ wires straight to its Redis
 * connection's own 'error' events. With zero listeners, an ordinary Redis
 * blip/restart throws synchronously outside any awaited call stack and
 * crashes the whole process - more likely to fire in production than the
 * stream-pipe bug crashSafety.ts already guards against. Every Worker in
 * this codebase already had its own listener; only the Queue producers
 * were missing one. This proves each of the 8 is now covered.
 */
const queues: Array<[string, { listenerCount(event: string): number; emit(event: string, ...args: unknown[]): boolean }]> = [
  ['incomingMessagesQueue', incomingMessagesQueue],
  ['outboundMessagesQueue', outboundMessagesQueue],
  ['documentParseQueue', documentParseQueue],
  ['emailSendQueue', emailSendQueue],
  ['funnelAdvanceQueue', funnelAdvanceQueue],
  ['messageRevocationsQueue', messageRevocationsQueue],
  ['realtimeEventsQueue', realtimeEventsQueue],
  ['scheduledStatusesQueue', scheduledStatusesQueue],
];

describe('every BullMQ Queue producer has a real error listener', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    // Always restored, even if an assertion above throws - otherwise a
    // failing test leaves console.error permanently wrapped, and the next
    // test's spy sees every prior call piled on top of its own.
    consoleErrorSpy.mockRestore();
  });

  it.each(queues)('%s has at least one "error" listener attached', (_label, queue) => {
    expect(queue.listenerCount('error')).toBeGreaterThan(0);
  });

  it.each(queues)('%s: a real "error" event is caught and logged, never thrown', (label, queue) => {
    expect(() => queue.emit('error', new Error('simulated Redis connection error'))).not.toThrow();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(label), expect.stringContaining('simulated Redis connection error'));
  });
});
