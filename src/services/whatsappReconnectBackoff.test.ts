import { describe, expect, it } from 'vitest';
import { reconnectDelayMs } from './whatsappReconnectBackoff.js';

describe('reconnectDelayMs', () => {
  it('grows exponentially across attempts (deterministic random = no jitter)', () => {
    const noJitter = () => 0.5; // random()*2-1 === 0 at 0.5
    expect(reconnectDelayMs(1, noJitter)).toBe(1_000);
    expect(reconnectDelayMs(2, noJitter)).toBe(2_000);
    expect(reconnectDelayMs(3, noJitter)).toBe(4_000);
    expect(reconnectDelayMs(4, noJitter)).toBe(8_000);
    expect(reconnectDelayMs(5, noJitter)).toBe(16_000);
  });

  it('caps at 30s even for very high attempt counts', () => {
    const noJitter = () => 0.5;
    expect(reconnectDelayMs(6, noJitter)).toBe(30_000);
    expect(reconnectDelayMs(50, noJitter)).toBe(30_000);
  });

  it('applies up to +/-20% jitter around the base delay', () => {
    const maxJitterUp = () => 1; // random()*2-1 === 1
    const maxJitterDown = () => 0; // random()*2-1 === -1

    expect(reconnectDelayMs(3, maxJitterUp)).toBe(4_800); // 4000 * 1.2
    expect(reconnectDelayMs(3, maxJitterDown)).toBe(3_200); // 4000 * 0.8
  });

  it('the regression case: two accounts reconnecting at the same attempt count do not get identical delays (jitter breaks synchronization)', () => {
    // Real Math.random() - the whole point is that back-to-back calls
    // representing two different accounts hitting the same attempt number
    // after a shared outage do not schedule at the exact same instant.
    const delays = new Set(Array.from({ length: 20 }, () => reconnectDelayMs(3)));
    expect(delays.size).toBeGreaterThan(1);
  });

  it('never returns a negative delay', () => {
    const extremeDown = () => 0;
    expect(reconnectDelayMs(1, extremeDown)).toBeGreaterThanOrEqual(0);
  });
});
