import { describe, expect, it } from 'vitest';
import {
  buildTimeContext,
  describeTimeContext,
  localDateParts,
  resolveNextLocalOccurrence,
  zonedWallClockToUtc,
} from '../../src/services/time/timeContext.js';

describe('buildTimeContext (pure - given a UTC instant and IANA zone, derives every locally-meaningful field)', () => {
  it('derives correct local fields for a known instant in a known zone', () => {
    // 2026-08-21T12:00:00Z is 08:00 in America/New_York (EDT, UTC-04:00 in August).
    const context = buildTimeContext(Date.parse('2026-08-21T12:00:00Z'), 'America/New_York', {
      status: 'SYNCED',
      lastSyncedAt: new Date('2026-08-21T11:55:00Z'),
      source: 'internet',
    });

    expect(context.timezone).toBe('America/New_York');
    expect(context.localDate).toBe('2026-08-21');
    expect(context.dayOfWeek).toBe('Friday');
    expect(context.utcOffset).toBe('-04:00');
    expect(context.localDateTime).toBe('2026-08-21T08:00:00-04:00');
    expect(context.syncStatus).toBe('SYNCED');
    expect(context.lastSyncedAt).toBe('2026-08-21T11:55:00.000Z');
    expect(context.source).toBe('internet');
  });

  it('reports a distinct offset for a zone in winter standard time vs. summer daylight time - never a hardcoded offset', () => {
    const winter = buildTimeContext(Date.parse('2026-01-15T12:00:00Z'), 'America/New_York', {
      status: 'SYNCED',
      lastSyncedAt: null,
      source: 'internet',
    });
    const summer = buildTimeContext(Date.parse('2026-07-15T12:00:00Z'), 'America/New_York', {
      status: 'SYNCED',
      lastSyncedAt: null,
      source: 'internet',
    });
    expect(winter.utcOffset).toBe('-05:00');
    expect(summer.utcOffset).toBe('-04:00');
  });

  it('never fabricates a sync status - passes through whatever status is given, including MANUAL_OVERRIDE', () => {
    const context = buildTimeContext(Date.now(), 'UTC', { status: 'MANUAL_OVERRIDE', lastSyncedAt: new Date(), source: 'manual' });
    expect(context.syncStatus).toBe('MANUAL_OVERRIDE');
  });
});

describe('describeTimeContext (prompt text honestly reflects sync state)', () => {
  it('states degraded/stale/manual override explicitly rather than presenting a stale value as live', () => {
    const base = { timezone: 'UTC', lastSyncedAt: new Date().toISOString() } as const;
    const synced = buildTimeContext(Date.now(), 'UTC', { status: 'SYNCED', lastSyncedAt: new Date(), source: 'internet' });
    const degraded = buildTimeContext(Date.now(), 'UTC', { status: 'DEGRADED', lastSyncedAt: new Date(), source: 'internet' });
    const stale = buildTimeContext(Date.now(), 'UTC', { status: 'STALE', lastSyncedAt: new Date(), source: 'system' });
    const manual = buildTimeContext(Date.now(), 'UTC', { status: 'MANUAL_OVERRIDE', lastSyncedAt: new Date(), source: 'manual' });

    expect(describeTimeContext(synced)).not.toContain('degraded');
    expect(describeTimeContext(synced)).not.toContain('stale');
    expect(describeTimeContext(degraded)).toContain('degraded');
    expect(describeTimeContext(stale)).toContain('stale');
    expect(describeTimeContext(manual)).toContain('MANUAL TIME OVERRIDE ACTIVE');
    void base;
  });
});

describe('zonedWallClockToUtc (a wall-clock reading in a zone -> the real UTC instant it represents)', () => {
  it('round-trips through buildTimeContext for an ordinary (non-DST-boundary) time', () => {
    const utc = zonedWallClockToUtc({ year: 2026, month: 8, day: 21, hour: 8, minute: 0 }, 'America/New_York');
    const context = buildTimeContext(utc.getTime(), 'America/New_York', { status: 'SYNCED', lastSyncedAt: null, source: 'test' });
    expect(context.localDateTime).toBe('2026-08-21T08:00:00-04:00');
  });

  it('handles the DST-start transition (nonexistent local time) without throwing, and picks a real instant', () => {
    // US DST begins 2026-03-08 at 02:00 local -> clocks jump to 03:00; 02:30 never occurs.
    const utc = zonedWallClockToUtc({ year: 2026, month: 3, day: 8, hour: 2, minute: 30 }, 'America/New_York');
    expect(Number.isNaN(utc.getTime())).toBe(false);
  });

  it('handles the DST-end transition (duplicated local time) without throwing, and picks a real instant', () => {
    // US DST ends 2026-11-01 at 02:00 local -> clocks fall back to 01:00; 01:30 occurs twice.
    const utc = zonedWallClockToUtc({ year: 2026, month: 11, day: 1, hour: 1, minute: 30 }, 'America/New_York');
    expect(Number.isNaN(utc.getTime())).toBe(false);
  });

  it('resolves the same wall-clock reading to different real UTC instants either side of a DST transition', () => {
    const beforeDst = zonedWallClockToUtc({ year: 2026, month: 3, day: 1, hour: 9, minute: 0 }, 'America/New_York');
    const afterDst = zonedWallClockToUtc({ year: 2026, month: 3, day: 15, hour: 9, minute: 0 }, 'America/New_York');
    // Same wall-clock hour, but one hour apart in real UTC terms because the offset changed.
    const beforeUtcHour = beforeDst.getUTCHours();
    const afterUtcHour = afterDst.getUTCHours();
    expect(afterUtcHour).toBe((beforeUtcHour + 23) % 24);
  });
});

describe('resolveNextLocalOccurrence (relative-date resolution the AI must use instead of guessing)', () => {
  it('resolves "today at 9am" to today when the time has not yet passed', () => {
    const now = Date.parse('2026-08-21T10:00:00-04:00'); // 10:00 America/New_York
    const next = resolveNextLocalOccurrence(now, 'America/New_York', 15, 0); // 3pm today
    const parts = localDateParts(next, 'America/New_York');
    expect(`${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`).toBe('2026-08-21');
  });

  it('rolls over to tomorrow when today\'s occurrence has already passed', () => {
    const now = Date.parse('2026-08-21T20:00:00-04:00'); // 8pm America/New_York
    const next = resolveNextLocalOccurrence(now, 'America/New_York', 9, 0); // 9am - already passed today
    const parts = localDateParts(next, 'America/New_York');
    expect(`${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`).toBe('2026-08-22');
    expect(next.getTime()).toBeGreaterThan(now);
  });

  it('resolves "next Monday at 10am" to a real future Monday, never a fabricated date', () => {
    // 2026-08-21 is a Friday.
    const now = Date.parse('2026-08-21T10:00:00-04:00');
    const next = resolveNextLocalOccurrence(now, 'America/New_York', 10, 0, 'MONDAY');
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' }).format(next);
    expect(weekday).toBe('Monday');
    expect(next.getTime()).toBeGreaterThan(now);
  });

  it('is always strictly in the future relative to the supplied "now"', () => {
    const now = Date.now();
    for (const [hour, minute] of [[0, 0], [12, 0], [23, 59]] as const) {
      const next = resolveNextLocalOccurrence(now, 'Asia/Tokyo', hour, minute);
      expect(next.getTime()).toBeGreaterThan(now);
    }
  });
});
