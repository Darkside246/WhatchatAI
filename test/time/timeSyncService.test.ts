import { afterEach, describe, expect, it, vi } from 'vitest';
import { TimeSyncService } from '../../src/services/time/timeSyncService.js';
import type { TimeProvider } from '../../src/services/time/timeProvider.js';

const FAST_CONFIG = {
  syncIntervalMs: 10_000,
  degradedAfterMs: 40,
  staleAfterMs: 90,
  retryBaseDelayMs: 50,
  retryMaxDelayMs: 400,
  fetchTimeoutMs: 1_000,
};

function fakeProvider(result: () => Promise<{ utcMillis: number; source: string }>): TimeProvider {
  return { name: 'fake', getCurrentUtcTime: result };
}

const services: TimeSyncService[] = [];
function makeService(provider: TimeProvider, config = FAST_CONFIG): TimeSyncService {
  const service = new TimeSyncService(provider, config);
  services.push(service);
  return service;
}

afterEach(() => {
  for (const service of services.splice(0)) service.stop();
});

describe('TimeSyncService (never synced yet)', () => {
  it('honestly reports STALE with a system fallback rather than pretending to be internet-synchronized', () => {
    const service = makeService(fakeProvider(() => Promise.reject(new Error('unused'))));
    const state = service.getState();
    expect(state.syncStatus).toBe('STALE');
    expect(state.source).toBe('system');
    expect(state.lastSyncedAt).toBeNull();
    expect(state.estimatedAccuracy).toBe('unknown');
    // Falls back to the real system clock, not a frozen/zero value.
    expect(Math.abs(state.utcNow - Date.now())).toBeLessThan(1_000);
  });
});

describe('TimeSyncService (successful calibration)', () => {
  it('reports SYNCED immediately after a successful sync, with the provider as source', async () => {
    const providerUtcMillis = Date.now() + 3_600_000; // deliberately offset from real now - proves the value came from the provider, not Date.now()
    const service = makeService(fakeProvider(() => Promise.resolve({ utcMillis: providerUtcMillis, source: 'internet' })));

    await service.syncOnce();
    const state = service.getState();

    expect(state.syncStatus).toBe('SYNCED');
    expect(state.source).toBe('internet');
    expect(state.provider).toBe('fake');
    expect(state.estimatedAccuracy).toBe('high');
    expect(state.lastSyncedAt).not.toBeNull();
    expect(Math.abs(state.utcNow - providerUtcMillis)).toBeLessThan(50);
  });

  it('degrades to DEGRADED then STALE purely from elapsed real time since the last success', async () => {
    const service = makeService(fakeProvider(() => Promise.resolve({ utcMillis: Date.now(), source: 'internet' })));
    await service.syncOnce();
    expect(service.getState().syncStatus).toBe('SYNCED');

    await new Promise((resolve) => setTimeout(resolve, FAST_CONFIG.degradedAfterMs + 15));
    expect(service.getState().syncStatus).toBe('DEGRADED');

    await new Promise((resolve) => setTimeout(resolve, FAST_CONFIG.staleAfterMs));
    expect(service.getState().syncStatus).toBe('STALE');
  });

  it('advances utcNow using real elapsed time since the last successful sync (monotonic-based interpolation)', async () => {
    const providerUtcMillis = 1_700_000_000_000;
    const service = makeService(fakeProvider(() => Promise.resolve({ utcMillis: providerUtcMillis, source: 'internet' })));
    await service.syncOnce();

    const firstReading = service.getState().utcNow;
    await new Promise((resolve) => setTimeout(resolve, 25));
    const secondReading = service.getState().utcNow;

    expect(secondReading).toBeGreaterThan(firstReading);
    expect(secondReading - firstReading).toBeGreaterThanOrEqual(20);
  });
});

describe('TimeSyncService (provider failure never throws out of syncOnce, and degrades gracefully)', () => {
  it('does not throw when the provider rejects, and schedules a backed-off retry', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const service = makeService(fakeProvider(() => Promise.reject(new Error('provider unavailable'))));

    await expect(service.syncOnce()).resolves.toBeUndefined();

    const state = service.getState();
    expect(state.syncStatus).toBe('STALE'); // never had a successful sync
    expect(state.lastError).toContain('provider unavailable');
    expect(state.consecutiveFailures).toBe(1);

    const scheduledDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
    expect(scheduledDelay).toBe(FAST_CONFIG.retryBaseDelayMs);
    setTimeoutSpy.mockRestore();
  });

  it('caps retry backoff at retryMaxDelayMs rather than growing unbounded', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const service = makeService(fakeProvider(() => Promise.reject(new Error('still down'))));

    // Enough consecutive failures that 2^n * base would exceed the cap.
    for (let i = 0; i < 6; i += 1) await service.syncOnce();

    const lastDelay = setTimeoutSpy.mock.calls.at(-1)?.[1];
    expect(lastDelay).toBe(FAST_CONFIG.retryMaxDelayMs);
    setTimeoutSpy.mockRestore();
  });

  it('recovers to SYNCED after a prior failure once the provider succeeds again', async () => {
    let shouldFail = true;
    const service = makeService(
      fakeProvider(() => (shouldFail ? Promise.reject(new Error('down')) : Promise.resolve({ utcMillis: Date.now(), source: 'internet' }))),
    );

    await service.syncOnce();
    expect(service.getState().syncStatus).toBe('STALE');
    expect(service.getState().consecutiveFailures).toBe(1);

    shouldFail = false;
    await service.syncOnce();
    expect(service.getState().syncStatus).toBe('SYNCED');
    expect(service.getState().consecutiveFailures).toBe(0);
    expect(service.getState().lastError).toBeNull();
  });
});
