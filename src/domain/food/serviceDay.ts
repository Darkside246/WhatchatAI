/**
 * A restaurant's day, not the calendar's.
 *
 * A kitchen that closes at one in the morning has one service, and a
 * summary that cuts it at midnight UTC splits a Friday night across two
 * reports and agrees with neither. So "today" means the business's own
 * local day, and a business can say when its day rolls over - a late-night
 * shop's Friday genuinely includes what it sold at 1am on Saturday.
 */

/**
 * The UTC instants that bracket one local service day.
 *
 * Built by asking the runtime what the local clock reads at a UTC instant
 * rather than by arithmetic on an offset. Offsets change - Barbados does
 * not observe daylight saving but plenty of places do, and a summary that
 * is an hour wrong twice a year is a summary somebody stops trusting.
 */
export function serviceDayBounds(
  day: string,
  timezone: string,
  options: { rolloverHour?: number } = {},
): { from: Date; to: Date } {
  const rollover = clampHour(options.rolloverHour ?? 0);
  const [year, month, date] = day.split('-').map(Number);
  if (!year || !month || !date) throw new Error(`"${day}" is not a date in YYYY-MM-DD form.`);

  const from = zonedTimeToUtc(year, month, date, rollover, timezone);
  // Exactly 24 hours later, taken the same way rather than by adding a day
  // in milliseconds, so a clock change inside the window does not shorten
  // or lengthen the service.
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  const to = zonedTimeToUtc(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), rollover, timezone);

  return { from, to };
}

/** Today's service day in this timezone, as YYYY-MM-DD. */
export function currentServiceDay(timezone: string, now: Date = new Date(), rolloverHour = 0): string {
  const local = localParts(now, timezone);
  // Before the rollover hour we are still in yesterday's service: 12:30am
  // on Saturday belongs to Friday night for a shop that rolls over at 4am.
  if (local.hour < clampHour(rolloverHour)) {
    const yesterday = new Date(Date.UTC(local.year, local.month - 1, local.date - 1));
    return isoDay(yesterday.getUTCFullYear(), yesterday.getUTCMonth() + 1, yesterday.getUTCDate());
  }
  return isoDay(local.year, local.month, local.date);
}

function clampHour(hour: number): number {
  return Number.isFinite(hour) ? Math.min(23, Math.max(0, Math.trunc(hour))) : 0;
}

function isoDay(year: number, month: number, date: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

function localParts(instant: Date, timezone: string): { year: number; month: number; date: number; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);

  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // 'en-GB' renders midnight as hour 24 rather than 00 in some runtimes;
  // normalising here rather than trusting it keeps the rollover comparison
  // from quietly inverting at exactly midnight.
  const hour = read('hour') % 24;
  return { year: read('year'), month: read('month'), date: read('day'), hour, minute: read('minute') };
}

/**
 * The UTC instant at which a given local wall-clock time occurs.
 *
 * Two passes: guess that local time equals UTC, measure how wrong that is
 * in the target zone, then correct. One correction is enough for every real
 * zone - the second pass only matters across a DST boundary, where it moves
 * the answer by the offset change and a third pass would move it no
 * further.
 */
function zonedTimeToUtc(year: number, month: number, date: number, hour: number, timezone: string): Date {
  const guess = new Date(Date.UTC(year, month - 1, date, hour, 0, 0, 0));
  const offset = offsetMillis(guess, timezone);
  const corrected = new Date(guess.getTime() - offset);
  const settled = offsetMillis(corrected, timezone);
  return settled === offset ? corrected : new Date(guess.getTime() - settled);
}

/** How far ahead of UTC this zone is at this instant, in milliseconds. */
function offsetMillis(instant: Date, timezone: string): number {
  const local = localParts(instant, timezone);
  const asUtc = Date.UTC(local.year, local.month - 1, local.date, local.hour, local.minute, instant.getUTCSeconds(), instant.getUTCMilliseconds());
  return asUtc - instant.getTime();
}
