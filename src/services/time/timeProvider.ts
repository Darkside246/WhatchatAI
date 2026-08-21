/**
 * A calibration source for "what time is it right now, authoritatively" -
 * deliberately narrow (one method, one result shape) so swapping the
 * internet provider for a different service never requires touching
 * TimeSyncService or anything above it.
 */
export interface TimeProviderResult {
  utcMillis: number;
  source: string;
}

export interface TimeProvider {
  readonly name: string;
  getCurrentUtcTime(): Promise<TimeProviderResult>;
}
