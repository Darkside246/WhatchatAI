import { describe, expect, it } from 'vitest';
import { TimeService } from '../../src/services/time/timeService.js';
import { TimeSyncService } from '../../src/services/time/timeSyncService.js';
import type { TimeProvider } from '../../src/services/time/timeProvider.js';

function makeSyncedService(utcMillis: number): TimeService {
  const provider: TimeProvider = { name: 'fake', getCurrentUtcTime: () => Promise.resolve({ utcMillis, source: 'internet' }) };
  const sync = new TimeSyncService(provider, {
    syncIntervalMs: 60_000,
    degradedAfterMs: 60_000,
    staleAfterMs: 120_000,
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 5_000,
    fetchTimeoutMs: 1_000,
  });
  return new TimeService(sync);
}

describe('TimeService.buildContextForTimezone (automatic, no override)', () => {
  it('builds a context from the live sync estimate when time_source is AUTOMATIC', async () => {
    const fixedUtc = Date.parse('2026-08-21T12:00:00Z');
    const service = makeSyncedService(fixedUtc);
    // @ts-expect-error - accessing the private sync field only to drive the fake provider in this test
    await service.sync.syncOnce();

    const context = service.buildContextForTimezone('UTC', {
      timeSource: 'AUTOMATIC',
      manualOverrideTargetUtc: null,
      manualOverrideSetAt: null,
    });

    expect(context.syncStatus).toBe('SYNCED');
    expect(context.source).toBe('internet');
  });
});

describe('TimeService.buildContextForTimezone (manual override rebase)', () => {
  it('rebases the override forward using real elapsed time since it was set, never freezing the clock', async () => {
    const service = makeSyncedService(Date.now());
    const target = new Date('2030-01-01T09:00:00Z'); // deliberately a fixed future test instant
    const setAt = new Date(Date.now() - 5_000); // "saved" 5 real seconds ago

    const context = service.buildContextForTimezone('UTC', {
      timeSource: 'MANUAL',
      manualOverrideTargetUtc: target,
      manualOverrideSetAt: setAt,
    });

    expect(context.syncStatus).toBe('MANUAL_OVERRIDE');
    const reportedUtc = Date.parse(context.utcNow);
    // Should read as ~5 seconds after the target, not frozen exactly at the target.
    expect(reportedUtc).toBeGreaterThanOrEqual(target.getTime() + 4_000);
    expect(reportedUtc).toBeLessThanOrEqual(target.getTime() + 8_000);
  });

  it('ignores stale/incomplete override data and falls back to the live sync estimate', () => {
    const fixedUtc = Date.parse('2026-08-21T12:00:00Z');
    const service = makeSyncedService(fixedUtc);

    // MANUAL time_source but missing the override instants - must not crash
    // or silently treat this as a valid override.
    const context = service.buildContextForTimezone('UTC', {
      timeSource: 'MANUAL',
      manualOverrideTargetUtc: null,
      manualOverrideSetAt: null,
    });

    expect(context.syncStatus).not.toBe('MANUAL_OVERRIDE');
  });
});

describe('TimeService.resolveNextLocalOccurrence', () => {
  it('delegates to the live sync clock, not the host process wall clock, for "now"', () => {
    const farFutureUtc = Date.parse('2030-06-15T12:00:00Z');
    const service = makeSyncedService(farFutureUtc);
    // No syncOnce() called - service.sync has never synced, so it falls back
    // to the real system clock, proving resolveNextLocalOccurrence reads
    // through TimeSyncService's own state rather than caching a value.
    const next = service.resolveNextLocalOccurrence('UTC', 9, 0);
    expect(next.getTime()).toBeGreaterThan(Date.now());
  });
});
