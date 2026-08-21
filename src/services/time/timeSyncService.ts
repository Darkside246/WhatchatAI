import { InternetTimeProvider } from './internetTimeProvider.js';
import type { TimeProvider } from './timeProvider.js';
import { TIME_CONFIG } from './config.js';

export type TimeSyncStatus = 'SYNCED' | 'DEGRADED' | 'STALE';

export interface TimeSyncState {
  /** Best current estimate of the real UTC instant, in milliseconds since epoch. */
  utcNow: number;
  lastSyncedAt: Date | null;
  syncStatus: TimeSyncStatus;
  source: string;
  provider: string;
  estimatedAccuracy: 'high' | 'degraded' | 'unknown';
  consecutiveFailures: number;
  lastError: string | null;
}

/**
 * Calibrates against an internet time source periodically (never per
 * message, never per AI call) and derives "now" the rest of the time from
 * that last successful calibration plus locally-measured elapsed time -
 * using Node's monotonic clock (process.hrtime.bigint()) for the elapsed
 * measurement specifically because it cannot be perturbed by NTP/manual
 * adjustments to the wall clock, unlike diffing two Date.now() reads.
 *
 * A provider failure never throws out of syncOnce() and never blocks
 * anything: it degrades the reported status and schedules a backed-off
 * retry, exactly per the fail-safe requirement that time sync must never
 * become a single point of failure for the rest of the application.
 */
export class TimeSyncService {
  private lastSuccessUtcMillis: number | null = null;
  private lastSuccessMonotonicNs: bigint | null = null;
  private lastSuccessAt: Date | null = null;
  private lastSuccessSource = 'system';
  private lastError: string | null = null;
  private consecutiveFailures = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private started = false;
  private stopped = false;

  constructor(
    private readonly provider: TimeProvider = new InternetTimeProvider(),
    private readonly config = TIME_CONFIG,
  ) {}

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.syncOnce();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private scheduleNext(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => void this.syncOnce(), delayMs);
    // A background calibration timer must never keep the process alive on
    // its own - clean shutdown of the server/worker process takes priority.
    this.timer.unref();
  }

  async syncOnce(): Promise<void> {
    try {
      const result = await this.provider.getCurrentUtcTime();
      this.lastSuccessUtcMillis = result.utcMillis;
      this.lastSuccessMonotonicNs = process.hrtime.bigint();
      this.lastSuccessAt = new Date();
      this.lastSuccessSource = result.source;
      this.consecutiveFailures = 0;
      this.lastError = null;
      this.scheduleNext(this.config.syncIntervalMs);
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastError = error instanceof Error ? error.message : String(error);
      const backoff = Math.min(
        this.config.retryBaseDelayMs * 2 ** (this.consecutiveFailures - 1),
        this.config.retryMaxDelayMs,
      );
      this.scheduleNext(backoff);
    }
  }

  getState(): TimeSyncState {
    const now = Date.now();

    if (this.lastSuccessUtcMillis === null || this.lastSuccessMonotonicNs === null || this.lastSuccessAt === null) {
      return {
        utcNow: now,
        lastSyncedAt: null,
        syncStatus: 'STALE',
        source: 'system',
        provider: this.provider.name,
        estimatedAccuracy: 'unknown',
        consecutiveFailures: this.consecutiveFailures,
        lastError: this.lastError,
      };
    }

    const elapsedNs = process.hrtime.bigint() - this.lastSuccessMonotonicNs;
    const elapsedMs = Number(elapsedNs / 1_000_000n);
    const estimatedUtcNow = this.lastSuccessUtcMillis + elapsedMs;
    const ageMs = now - this.lastSuccessAt.getTime();

    let syncStatus: TimeSyncStatus;
    if (ageMs <= this.config.degradedAfterMs && this.consecutiveFailures === 0) {
      syncStatus = 'SYNCED';
    } else if (ageMs <= this.config.staleAfterMs) {
      syncStatus = 'DEGRADED';
    } else {
      syncStatus = 'STALE';
    }

    return {
      utcNow: estimatedUtcNow,
      lastSyncedAt: this.lastSuccessAt,
      syncStatus,
      source: this.lastSuccessSource,
      provider: this.provider.name,
      estimatedAccuracy: syncStatus === 'SYNCED' ? 'high' : syncStatus === 'DEGRADED' ? 'degraded' : 'unknown',
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
    };
  }
}

export const timeSyncService = new TimeSyncService();
