import { describe, expect, it } from 'vitest';
import { delayUntilNextActiveHourMs, MAX_TIMING_DELAY_MS } from './contactAvailabilityService.js';

describe('delayUntilNextActiveHourMs (pure - no I/O)', () => {
  it('returns 0 when we are already in the contact\'s most active hour', () => {
    const now = new Date('2026-01-01T14:30:00.000Z');
    expect(delayUntilNextActiveHourMs(14, now)).toBe(0);
  });

  it('computes the delay to a later hour the same day', () => {
    const now = new Date('2026-01-01T10:00:00.000Z');
    // 10:00 -> 18:00 is 8 hours.
    expect(delayUntilNextActiveHourMs(18, now)).toBe(8 * 60 * 60 * 1000);
  });

  it('wraps past midnight when the target hour has already passed today', () => {
    const now = new Date('2026-01-01T20:00:00.000Z');
    // 20:00 -> next day 06:00 is 10 hours.
    expect(delayUntilNextActiveHourMs(6, now)).toBe(10 * 60 * 60 * 1000);
  });

  it('never exceeds the 24h bound, even at the wrap-around extreme', () => {
    const now = new Date('2026-01-01T00:30:00.000Z');
    const delay = delayUntilNextActiveHourMs(23, now);
    expect(delay).toBeLessThanOrEqual(MAX_TIMING_DELAY_MS);
    expect(delay).toBeGreaterThan(0);
  });
});
