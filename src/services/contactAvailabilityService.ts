import type { Queryable } from '../repositories/types.js';

/**
 * Sections 32/33 (timing engine, contact availability intelligence): this
 * codebase has no per-contact timezone field and no self-reported
 * "quiet hours" - timeZoneResolver.ts's own doc comment admits it always
 * falls back to the business default because no location/device signal is
 * ever collected from a WhatsApp customer. Rather than inventing a
 * collection mechanism this session has no scope to build, this derives a
 * genuinely real signal from data that already exists: when this specific
 * contact has actually sent messages in the past. Observed behavior, not
 * a self-report - arguably more honest than a timezone field would be
 * anyway (a contact's real timezone doesn't tell you when they're
 * actually free to read WhatsApp).
 */

/** Below this many real inbound messages, a "most active hour" is noise, not signal - honestly returning null (unknown) rather than a one-message guess. */
const MIN_SAMPLE_SIZE = 5;
/** Never let "wait for their best hour" silently stall a campaign for more than a day - a bounded tradeoff, not an unbounded delay. */
export const MAX_TIMING_DELAY_MS = 24 * 60 * 60 * 1000;

export interface ContactActivityProfile {
  /** 0-23, UTC. The hour-of-day this contact has most often sent a real inbound message. */
  mostActiveHourUtc: number;
  sampleSize: number;
}

interface HourCountRow {
  hour: number;
  count: number;
}

/** Real inbound-message timestamps for this one chat, aggregated by UTC hour-of-day. Null when there isn't enough real history to trust a signal from. */
export async function computeContactActivityProfile(db: Queryable, chatId: string): Promise<ContactActivityProfile | null> {
  const { rows } = await db.query<HourCountRow>(
    `SELECT EXTRACT(HOUR FROM "timestamp" AT TIME ZONE 'UTC')::int AS hour, count(*)::int AS count
     FROM whatsapp_messages
     WHERE chat_id = $1 AND direction = 'inbound'
     GROUP BY hour
     ORDER BY count DESC, hour ASC`,
    [chatId],
  );
  const sampleSize = rows.reduce((sum, row) => sum + row.count, 0);
  const best = rows[0];
  if (!best || sampleSize < MIN_SAMPLE_SIZE) return null;
  return { mostActiveHourUtc: best.hour, sampleSize };
}

/**
 * Pure - the next UTC moment this contact's most-active hour occurs,
 * relative to `now`. Treats "we are already in their best hour right now"
 * as delay 0 (send it, don't make them wait a full day for the exact same
 * hour to come back around) - genuinely bounded to under 24h either way.
 */
export function delayUntilNextActiveHourMs(mostActiveHourUtc: number, now: Date = new Date()): number {
  const currentHour = now.getUTCHours();
  if (currentHour === mostActiveHourUtc) return 0;
  let hoursAhead = mostActiveHourUtc - currentHour;
  if (hoursAhead < 0) hoursAhead += 24;
  const target = new Date(now);
  target.setUTCMinutes(0, 0, 0);
  target.setUTCHours(currentHour + hoursAhead);
  return Math.max(0, Math.min(MAX_TIMING_DELAY_MS, target.getTime() - now.getTime()));
}

/**
 * The one function campaignService.ts actually calls: real signal in,
 * real bounded delay out - 0 when there isn't enough history to say
 * anything real, never a fabricated "best time" for a contact this
 * business has barely heard from yet.
 */
export async function computeSendTimingDelayMs(db: Queryable, chatId: string, now: Date = new Date()): Promise<number> {
  const profile = await computeContactActivityProfile(db, chatId);
  if (!profile) return 0;
  return delayUntilNextActiveHourMs(profile.mostActiveHourUtc, now);
}
