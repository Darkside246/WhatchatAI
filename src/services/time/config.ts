/**
 * Every tunable threshold for the time-sync/timezone system lives here -
 * nothing below this module should hard-code an interval or age threshold
 * directly, so operators can retune behaviour via environment variables
 * without hunting through TimeSyncService/TimeService internals.
 */
function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const TIME_CONFIG = {
  /** How often TimeSyncService attempts a fresh internet calibration. */
  syncIntervalMs: envMs('TIME_SYNC_INTERVAL_MS', 15 * 60_000),
  /** Age of the last successful sync beyond which status degrades from SYNCED to DEGRADED. */
  degradedAfterMs: envMs('TIME_SYNC_DEGRADED_AFTER_MS', 20 * 60_000),
  /** Age of the last successful sync beyond which status becomes STALE. */
  staleAfterMs: envMs('TIME_SYNC_STALE_AFTER_MS', 60 * 60_000),
  /** Base delay for the first retry after a failed sync attempt. */
  retryBaseDelayMs: envMs('TIME_SYNC_RETRY_BASE_MS', 5_000),
  /** Ceiling for exponential retry backoff after repeated failures. */
  retryMaxDelayMs: envMs('TIME_SYNC_RETRY_MAX_MS', 5 * 60_000),
  /** Network timeout for a single calibration request. */
  fetchTimeoutMs: envMs('TIME_SYNC_TIMEOUT_MS', 4_000),
};
