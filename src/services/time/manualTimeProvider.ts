import type { TimeProvider, TimeProviderResult } from './timeProvider.js';

/**
 * Rebases a fixed operator-set "logical now" forward using real elapsed
 * wall-clock time since it was saved, rather than freezing the clock at a
 * stale instant. Never mutates the host OS clock - this only ever feeds
 * TimeService's own logical time context for one business.
 */
export class ManualTimeProvider implements TimeProvider {
  readonly name = 'manual';

  constructor(
    private readonly targetUtcMillis: number,
    private readonly setAtUtcMillis: number,
  ) {}

  async getCurrentUtcTime(): Promise<TimeProviderResult> {
    const elapsed = Math.max(0, Date.now() - this.setAtUtcMillis);
    return { utcMillis: this.targetUtcMillis + elapsed, source: this.name };
  }
}
