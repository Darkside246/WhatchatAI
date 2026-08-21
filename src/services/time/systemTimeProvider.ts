import type { TimeProvider, TimeProviderResult } from './timeProvider.js';

/** The last-resort fallback: the host process's own wall clock, never trusted as internet-synchronized. */
export class SystemTimeProvider implements TimeProvider {
  readonly name = 'system';

  async getCurrentUtcTime(): Promise<TimeProviderResult> {
    return { utcMillis: Date.now(), source: this.name };
  }
}
