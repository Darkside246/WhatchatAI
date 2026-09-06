import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Isolated into its own file: mocking queueHealth.ts affects every rule
 * in oversightSweepService.ts that calls it (application_health AND the
 * capacity-forecast sample recorder), so this must not share a module
 * registry with oversightSweepService.test.ts's own real-queue-dependent
 * assertions - vi.mock is file-scoped/hoisted, and a shared file would
 * make every other test in that file see the same forced failure.
 */
vi.mock('../src/queue/queueHealth.js', () => ({
  checkQueueHealth: vi.fn().mockRejectedValue(new Error('Redis unreachable (simulated)')),
}));

import { pool } from '../src/db/pool.js';
import { runOversightSweep } from '../src/services/oversight/oversightSweepService.js';
import { OversightFindingRepository } from '../src/repositories/oversightFindingRepository.js';
import { resetDatabase } from './helpers.js';

const oversightFindingRepository = new OversightFindingRepository(pool);

// Same real environment quirk oversightSweepService.test.ts and
// systemHealthService.test.ts both work around: this env's real
// GOOSE_SERVICE_URL points nowhere reachable, so every sweep call would
// otherwise eat a real, bounded-but-real 5s timeout via getSystemHealth().
let originalGooseUrl: string | undefined;
beforeEach(() => {
  originalGooseUrl = process.env.GOOSE_SERVICE_URL;
  delete process.env.GOOSE_SERVICE_URL;
});
afterEach(() => {
  if (originalGooseUrl !== undefined) process.env.GOOSE_SERVICE_URL = originalGooseUrl;
});

describe('oversightSweepService self-monitoring (real Postgres) - one rule\'s own failure must never silently report "all clear"', () => {
  it('a rule whose data source throws produces a real monitoring_degraded finding naming that rule, and every other rule in the same sweep still completes normally', async () => {
    await resetDatabase();
    await runOversightSweep();

    const all = await oversightFindingRepository.listOpenAcrossPlatform();
    const degraded = all.filter((f) => f.findingType === 'monitoring_degraded');
    // application_health and capacity_forecast (sampleAndForecastCapacity) both call checkQueueHealth - both must self-report degradation, not silently pass.
    expect(degraded.map((f) => (f.evidence as { rule?: string }).rule).sort()).toEqual(['application_health', 'capacity_forecast']);
    expect(degraded.every((f) => f.severity === 'medium')).toBe(true);

    // A rule with no dependency on the mocked module (monitoring gaps) still ran and reported normally in the same sweep tick.
    const gaps = all.filter((f) => f.category === 'monitoring_gap' && f.findingType !== 'monitoring_degraded');
    expect(gaps.length).toBeGreaterThan(0);
  });
});
