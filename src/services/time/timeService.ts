import { pool } from '../../db/pool.js';
import { BusinessRepository, type BusinessRecord } from '../../repositories/businessRepository.js';
import { timeSyncService, TimeSyncService, type TimeSyncState } from './timeSyncService.js';
import { buildTimeContext, resolveNextLocalOccurrence, type TimeContext, type WeekdayName } from './timeContext.js';
import { resolveBusinessTimezone } from './timeZoneResolver.js';

export {
  resolveBusinessTimezone,
  resolveUserTimezone,
  resolveCustomerTimezone,
  SYSTEM_FALLBACK_TIMEZONE,
} from './timeZoneResolver.js';
export { WEEKDAY_NAMES } from './timeContext.js';
export type { TimeContext, TimeSyncStatus, WeekdayName } from './timeContext.js';
export type { TimeSyncState } from './timeSyncService.js';

type ManualOverrideFields = Pick<BusinessRecord, 'timeSource' | 'manualOverrideTargetUtc' | 'manualOverrideSetAt'>;

/**
 * The single façade the rest of the application talks to for "what time is
 * it": wraps TimeSyncService (background internet calibration) and the
 * timezone resolvers, and is the only place that knows how to turn a
 * business's manual-override columns into a rebased TimeContext. Every
 * read here is synchronous/non-blocking except buildBusinessTimeContext,
 * which does one indexed primary-key lookup - never a network call.
 */
export class TimeService {
  constructor(private readonly sync: TimeSyncService = timeSyncService) {}

  start(): void {
    this.sync.start();
  }

  getSyncState(): TimeSyncState {
    return this.sync.getState();
  }

  /**
   * `business` optionally carries manual-override state. When
   * `time_source === 'MANUAL'` and both override columns are set, the
   * returned context is rebased from the stored override instead of the
   * live sync estimate - this is the only path that can produce a
   * MANUAL_OVERRIDE TimeContext. It can only be reached through data
   * written by the authenticated Settings endpoint; no AI tool writes
   * these columns, so no conversation input can ever activate it.
   */
  buildContextForTimezone(timezone: string, business?: ManualOverrideFields): TimeContext {
    if (business?.timeSource === 'MANUAL' && business.manualOverrideTargetUtc && business.manualOverrideSetAt) {
      const elapsed = Math.max(0, Date.now() - business.manualOverrideSetAt.getTime());
      const overrideUtcMillis = business.manualOverrideTargetUtc.getTime() + elapsed;
      return buildTimeContext(overrideUtcMillis, timezone, {
        status: 'MANUAL_OVERRIDE',
        lastSyncedAt: business.manualOverrideSetAt,
        source: 'manual',
      });
    }

    const state = this.sync.getState();
    return buildTimeContext(state.utcNow, timezone, {
      status: state.syncStatus,
      lastSyncedAt: state.lastSyncedAt,
      source: state.source,
    });
  }

  /** Convenience path used by the AI reply pipeline and dashboard: resolves the business's own timezone/override state in one lookup and builds its TimeContext. */
  async buildBusinessTimeContext(businessId: string): Promise<TimeContext> {
    const business = await new BusinessRepository(pool).findById(businessId);
    const timezone = resolveBusinessTimezone({ timezone: business?.timezone ?? null });
    return this.buildContextForTimezone(timezone, business ?? undefined);
  }

  /** Next real UTC instant a local wall-clock time (e.g. "09:00", optionally a specific weekday) occurs in a timezone - used by funnel WAIT-until-local-time steps and available for campaign scheduling. Uses the live synced clock, never Date.now() directly. */
  resolveNextLocalOccurrence(timezone: string, hour: number, minute: number, dayOfWeek?: WeekdayName): Date {
    return resolveNextLocalOccurrence(this.sync.getState().utcNow, timezone, hour, minute, dayOfWeek);
  }
}

export const timeService = new TimeService();
