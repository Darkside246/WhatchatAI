import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { fingerprintPhoneNumber } from '../src/security/phoneFingerprint.js';
import {
  listAllAccounts,
  manuallyChangeBusinessPlan,
  extendBusinessTrial,
  BusinessHasNoSubscriptionError,
  NotTrialingError,
} from '../src/services/platform/developerAccountsService.js';
import { createTestBusiness, createTestUser, createTestSubscription, resetDatabase } from './helpers.js';

const userRepository = new UserRepository(pool);

async function setPhone(businessId: string, userId: string, e164Phone: string): Promise<void> {
  await userRepository.updatePhoneNumber(businessId, userId, e164Phone, fingerprintPhoneNumber(e164Phone));
}

describe('developerAccountsService (real Postgres) - the real, cross-tenant Accounts view', () => {
  it('includes every real user, including one flagged platform_role=DEVELOPER (the "including myself" requirement)', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    await pool.query(`UPDATE users SET platform_role = 'DEVELOPER' WHERE id = $1`, [userId]);
    await setPhone(businessId, userId, '+12025550123');

    const accounts = await listAllAccounts();
    const mine = accounts.find((a) => a.userId === userId);
    expect(mine).toBeDefined();
    expect(mine?.isDeveloper).toBe(true);
    expect(mine?.phoneNumber).toBe('+12025550123');
  });

  it('sorts by real phone number in numeric order - a short number never sorts ahead of a longer one via naive string comparison', async () => {
    await resetDatabase();
    const businessA = await createTestBusiness('Business A');
    const businessB = await createTestBusiness('Business B');
    const businessC = await createTestBusiness('Business C');
    const userA = await createTestUser(businessA);
    const userB = await createTestUser(businessB);
    const userC = await createTestUser(businessC);
    await setPhone(businessA, userA, '+19999999999'); // 11 digits, numerically large
    await setPhone(businessB, userB, '+9');            // 1 digit, numerically tiny
    await setPhone(businessC, userC, '+12025550100');   // 11 digits, numerically smaller than A

    const accounts = await listAllAccounts();
    const withPhones = accounts.filter((a) => [userA, userB, userC].includes(a.userId));
    expect(withPhones.map((a) => a.userId)).toEqual([userB, userC, userA]);
  });

  it('a user with no phone on file sorts last, never dropped from the list', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const withPhone = await createTestUser(businessId);
    const withoutPhone = await createTestUser(businessId);
    await setPhone(businessId, withPhone, '+12025550123');

    const accounts = await listAllAccounts();
    const withPhoneIndex = accounts.findIndex((a) => a.userId === withPhone);
    const withoutPhoneIndex = accounts.findIndex((a) => a.userId === withoutPhone);
    expect(withoutPhoneIndex).toBeGreaterThan(withPhoneIndex);
    expect(accounts.find((a) => a.userId === withoutPhone)?.phoneNumber).toBeNull();
  });

  it('surfaces the real signup date and live subscription/plan status for a business', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    await createTestSubscription(businessId, 'starter');

    const accounts = await listAllAccounts();
    const account = accounts.find((a) => a.userId === userId);
    expect(account?.businessName).toBeTruthy();
    expect(account?.subscriptionStatus).toBe('TRIALING');
    expect(account?.planKey).toBe('starter');
    expect(typeof account?.signupDate).toBe('string');
  });

  describe('manuallyChangeBusinessPlan (the real gap this feature closes)', () => {
    it('moves a business onto a different real plan', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestUser(businessId);
      await createTestSubscription(businessId, 'starter');

      const { planName } = await manuallyChangeBusinessPlan(businessId, 'growth');
      expect(planName).toBe('Growth');

      const accounts = await listAllAccounts();
      const account = accounts.find((a) => a.businessId === businessId);
      expect(account?.planKey).toBe('growth');
    });

    /**
     * This deliberately REVERSES an earlier decision here ("refuses a
     * business with no active subscription, rather than creating one
     * implicitly"). That rule and the button's own description were in
     * conflict, and the description was right: the control plane offers
     * this for "a payment that never came through the automated checkout (a
     * missed webhook, cash, an out-of-band transfer)" - a business in
     * exactly that state has no subscription to change, so the refusal made
     * the feature unusable on every account it was built for. Seen in
     * production as a 409 on every row reading "No subscription".
     */
    it('creates the subscription for a business that has none - the out-of-band payment case', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestUser(businessId); // listAllAccounts is a list of users

      const { planName } = await manuallyChangeBusinessPlan(businessId, 'growth');
      expect(planName).toBe('Growth');

      const accounts = await listAllAccounts();
      const account = accounts.find((a) => a.businessId === businessId);
      expect(account?.planKey).toBe('growth');
      // ACTIVE, not TRIALING: this records someone who has actually paid,
      // and a trial clock would expire and lock them out.
      expect(account?.subscriptionStatus).toBe('ACTIVE');
      expect(account?.trialEndsAt).toBeNull();
    });

    it('changes the plan of an existing subscription rather than creating a second one', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'starter');

      await manuallyChangeBusinessPlan(businessId, 'growth');

      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM subscriptions WHERE business_id = $1',
        [businessId],
      );
      expect(rows[0]!.count).toBe('1');
    });

    it('refuses an unknown plan key', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'starter');
      await expect(manuallyChangeBusinessPlan(businessId, 'not-a-real-plan')).rejects.toThrow('Unknown plan key');
    });
  });

  describe('extendBusinessTrial', () => {
    it('adds the days to a trial that has not run out yet', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestUser(businessId);
      await createTestSubscription(businessId, 'starter');

      const before = await pool.query<{ trial_ends_at: string }>(
        'SELECT trial_ends_at FROM subscriptions WHERE business_id = $1',
        [businessId],
      );
      const extended = await extendBusinessTrial(businessId, 7);

      const gainedMs = new Date(extended.trialEndsAt!).getTime() - new Date(before.rows[0]!.trial_ends_at).getTime();
      expect(Math.round(gainedMs / 86_400_000)).toBe(7);
    });

    /**
     * Adding seven days to a date that has already passed would hand back a
     * trial that is still expired - the extension has to be measured from
     * now in that case, or it does nothing at all.
     */
    it('gives a full window even when the trial already lapsed', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestUser(businessId);
      await createTestSubscription(businessId, 'starter');
      await pool.query(
        "UPDATE subscriptions SET trial_ends_at = now() - interval '30 days' WHERE business_id = $1",
        [businessId],
      );

      const extended = await extendBusinessTrial(businessId, 7);
      expect(new Date(extended.trialEndsAt!).getTime()).toBeGreaterThan(Date.now());
    });

    it('refuses a subscription that is not trialing', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestUser(businessId);
      await createTestSubscription(businessId, 'starter');
      await pool.query("UPDATE subscriptions SET status = 'ACTIVE' WHERE business_id = $1", [businessId]);

      // A trial end date on a paying subscription is meaningless at best,
      // and the expiry sweep reads trial_ends_at - so at worst it would be a
      // way to cancel a paying customer.
      await expect(extendBusinessTrial(businessId, 7)).rejects.toThrow(NotTrialingError);
    });

    it('refuses a business with no live subscription', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await expect(extendBusinessTrial(businessId, 7)).rejects.toThrow(BusinessHasNoSubscriptionError);
    });
  });
});
