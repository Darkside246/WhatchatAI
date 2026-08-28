import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { redisClient } from '../redis/client.js';
import { tryAcquireGroupSyncCooldown } from './whatsappGroupSyncCooldown.js';

describe('tryAcquireGroupSyncCooldown', () => {
  const claimedKeys: string[] = [];

  afterEach(async () => {
    // Real Redis (per this project's test convention - see test/globalSetup.ts),
    // not a mock, so cooldown keys from one test must not bleed into the next.
    await Promise.all(claimedKeys.splice(0).map((key) => redisClient.del(key)));
  });

  function freshAccountId(): string {
    const id = randomUUID();
    claimedKeys.push(`wa:group-sync-cooldown:${id}`);
    return id;
  }

  it('the regression case: 10 reconnects for one account do not produce 10 approved fetches - only the first wins', async () => {
    const accountId = freshAccountId();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => tryAcquireGroupSyncCooldown(accountId)),
    );

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((r) => !r)).toHaveLength(9);
  });

  it('a second reconnect immediately after the first is rejected (cooldown is in effect)', async () => {
    const accountId = freshAccountId();

    const first = await tryAcquireGroupSyncCooldown(accountId);
    const second = await tryAcquireGroupSyncCooldown(accountId);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it('the lock is per-account - a busy account never blocks a different account from syncing', async () => {
    const accountA = freshAccountId();
    const accountB = freshAccountId();

    await tryAcquireGroupSyncCooldown(accountA);
    const acquiredB = await tryAcquireGroupSyncCooldown(accountB);

    expect(acquiredB).toBe(true);
  });

  it('the lock survives being checked from a fresh call (Redis-backed, not process memory)', async () => {
    const accountId = freshAccountId();

    await tryAcquireGroupSyncCooldown(accountId);
    // A real restart can't be simulated in-process, but the property that
    // matters - the lock lives in Redis, not a local variable this process
    // owns - is verified directly: the key must actually be present with a
    // real TTL, not just "true was returned once."
    const ttl = await redisClient.ttl(`wa:group-sync-cooldown:${accountId}`);

    expect(ttl).toBeGreaterThan(0);
  });

  it('a fresh window (short TTL) allows exactly one more successful acquire once it expires', async () => {
    const accountId = freshAccountId();

    const first = await tryAcquireGroupSyncCooldown(accountId, 1);
    expect(first).toBe(true);

    const duringWindow = await tryAcquireGroupSyncCooldown(accountId, 1);
    expect(duringWindow).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 1100));

    const afterExpiry = await tryAcquireGroupSyncCooldown(accountId, 1);
    expect(afterExpiry).toBe(true);
  });
});
