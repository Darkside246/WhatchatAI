export type TimeSyncStatus = 'SYNCED' | 'DEGRADED' | 'STALE' | 'MANUAL_OVERRIDE';

/**
 * The trusted, structured time payload handed to the AI runtime and the
 * dashboard - never a value either is expected to compute or infer itself.
 */
export interface TimeContext {
  utcNow: string;
  timezone: string;
  localDateTime: string;
  localDate: string;
  dayOfWeek: string;
  utcOffset: string;
  syncStatus: TimeSyncStatus;
  lastSyncedAt: string | null;
  source: string;
}

function datePartsInZone(date: Date, timezone: string) {
  // hourCycle 'h23' guarantees a zero-padded 00-23 hour with no AM/PM
  // ambiguity, and formatToParts (rather than the formatted string) avoids
  // any dependency on a particular locale's part ordering/separators.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

function utcOffsetInZone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, timeZoneName: 'longOffset' }).formatToParts(date);
  const raw = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  if (raw === 'GMT') return '+00:00';
  const match = /^GMT([+-]\d{2}:\d{2})$/.exec(raw);
  return match?.[1] ?? '+00:00';
}

function offsetStringToMinutes(offset: string): number {
  const sign = offset.startsWith('-') ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(':').map(Number);
  return sign * ((hours ?? 0) * 60 + (minutes ?? 0));
}

/** Numeric year/month/day as they read in the given IANA zone - pure calendar components, not an instant. */
export function localDateParts(date: Date, timezone: string): { year: number; month: number; day: number } {
  const { year, month, day } = datePartsInZone(date, timezone);
  return { year: Number(year), month: Number(month), day: Number(day) };
}

function addLocalDays(parts: { year: number; month: number; day: number }, days: number): { year: number; month: number; day: number } {
  // Pure calendar arithmetic (month/year rollover) - deliberately done in a
  // scratch UTC instant, unrelated to any real timezone, since Y/M/D+N
  // never needs timezone awareness.
  const rolled = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: rolled.getUTCFullYear(), month: rolled.getUTCMonth() + 1, day: rolled.getUTCDate() };
}

export const WEEKDAY_NAMES = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'] as const;
export type WeekdayName = (typeof WEEKDAY_NAMES)[number];

/**
 * Resolves the next real UTC instant at which a given local wall-clock time
 * (e.g. "09:00", optionally restricted to a specific weekday) next occurs in
 * a timezone - always strictly after `nowUtcMillis`, always via the
 * runtime's own tz database, never manual day/offset arithmetic. Used by
 * funnel WAIT-until-local-time steps and available for campaign scheduling.
 */
export function resolveNextLocalOccurrence(
  nowUtcMillis: number,
  timezone: string,
  hour: number,
  minute: number,
  dayOfWeek?: WeekdayName,
): Date {
  const todayParts = localDateParts(new Date(nowUtcMillis), timezone);
  let candidate = zonedWallClockToUtc({ ...todayParts, hour, minute, second: 0 }, timezone);
  if (candidate.getTime() <= nowUtcMillis) {
    const tomorrowParts = addLocalDays(todayParts, 1);
    candidate = zonedWallClockToUtc({ ...tomorrowParts, hour, minute, second: 0 }, timezone);
  }

  if (dayOfWeek) {
    for (let i = 0; i < 7; i += 1) {
      const actualDay = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(candidate).toUpperCase();
      if (actualDay === dayOfWeek) break;
      const candidateParts = localDateParts(candidate, timezone);
      const nextParts = addLocalDays(candidateParts, 1);
      candidate = zonedWallClockToUtc({ ...nextParts, hour, minute, second: 0 }, timezone);
    }
  }

  return candidate;
}

export interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second?: number;
}

/**
 * Converts a wall-clock time as it should read IN a given IANA zone (e.g.
 * "09:00 in America/New_York") into the real UTC instant it represents -
 * never manual offset arithmetic, so this stays correct across DST. Two
 * fixed-point correction passes: the offset at a naive first guess almost
 * always already matches the true offset, and a second pass corrects the
 * rare case where the guess landed close to a DST transition.
 */
export function zonedWallClockToUtc(parts: WallClockParts, timezone: string): Date {
  const naiveUtcMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second ?? 0);
  let resolvedMs = naiveUtcMs;
  for (let i = 0; i < 2; i += 1) {
    const offsetMinutes = offsetStringToMinutes(utcOffsetInZone(new Date(resolvedMs), timezone));
    resolvedMs = naiveUtcMs - offsetMinutes * 60_000;
  }
  return new Date(resolvedMs);
}

/** Human-readable summary for prompt injection - always states the sync status honestly rather than presenting a stale/manual value as live. */
export function describeTimeContext(context: TimeContext): string {
  const localTime = context.localDateTime.slice(11, 19);
  const base = `${context.dayOfWeek}, ${context.localDate} ${localTime} (UTC${context.utcOffset}, timezone: ${context.timezone})`;
  switch (context.syncStatus) {
    case 'SYNCED':
      return base;
    case 'DEGRADED':
      return `${base} - time synchronization is degraded (last confirmed ${context.lastSyncedAt ?? 'unknown'}); treat as approximate`;
    case 'STALE':
      return `${base} - time synchronization is stale (last confirmed ${context.lastSyncedAt ?? 'unknown'}); treat with reduced confidence`;
    case 'MANUAL_OVERRIDE':
      return `${base} - MANUAL TIME OVERRIDE ACTIVE (operator-set for testing, not real time)`;
    default:
      return base;
  }
}

export interface SyncMetadata {
  status: TimeSyncStatus;
  lastSyncedAt: Date | null;
  source: string;
}

/** Pure: given an authoritative UTC instant and an IANA zone, derives every locally-meaningful field via the runtime's own tz database - never manual offset arithmetic, so DST transitions are handled automatically. */
export function buildTimeContext(utcMillis: number, timezone: string, sync: SyncMetadata): TimeContext {
  const date = new Date(utcMillis);
  const { year, month, day, hour, minute, second } = datePartsInZone(date, timezone);
  const offset = utcOffsetInZone(date, timezone);
  const dayOfWeek = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' }).format(date);
  const localDate = `${year}-${month}-${day}`;

  return {
    utcNow: date.toISOString(),
    timezone,
    localDateTime: `${localDate}T${hour}:${minute}:${second}${offset}`,
    localDate,
    dayOfWeek,
    utcOffset: offset,
    syncStatus: sync.status,
    lastSyncedAt: sync.lastSyncedAt ? sync.lastSyncedAt.toISOString() : null,
    source: sync.source,
  };
}
