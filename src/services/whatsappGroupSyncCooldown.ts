import { redisClient } from '../redis/client.js';

// 15 minutes: long enough that a burst of reconnects (network blip, server
// restart, phone going idle and waking back up) collapses into at most one
// real groupFetchAllParticipating() call, short enough that a business
// whose group membership actually changed still gets a fresh sync within
// the same working session.
export const GROUP_SYNC_COOLDOWN_SECONDS = 15 * 60;

/**
 * Claims the group-sync cooldown window for one WhatsApp account. Returns
 * true for exactly one caller per window - that caller may proceed to call
 * groupFetchAllParticipating(); every other caller within the same window
 * gets false and must skip the fetch entirely, not queue or retry it.
 *
 * Backed by Redis (SET NX EX), not process memory: the lock survives a
 * process restart mid-cooldown and holds across every reconnect in the
 * window, not just the ones a single process instance happens to see.
 * Without this, a run of reconnects (a network blip, a phone going idle,
 * multiple businesses reconnecting around one server restart) each
 * re-triggered a full group fetch against WhatsApp's own servers - the
 * direct cause of the rate-overlimit / 429 seen in production.
 */
export async function tryAcquireGroupSyncCooldown(
  accountId: string,
  ttlSeconds: number = GROUP_SYNC_COOLDOWN_SECONDS,
): Promise<boolean> {
  const key = `wa:group-sync-cooldown:${accountId}`;
  const result = await redisClient.set(key, '1', 'EX', ttlSeconds, 'NX');
  return result === 'OK';
}
