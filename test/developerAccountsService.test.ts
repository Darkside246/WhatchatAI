import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { fingerprintPhoneNumber } from '../src/security/phoneFingerprint.js';
import { listAllAccounts, manuallyChangeBusinessPlan, BusinessHasNoSubscriptionError } from '../src/services/platform/developerAccountsService.js';
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

    it('refuses a business with no active subscription, rather than creating one implicitly', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await expect(manuallyChangeBusinessPlan(businessId, 'growth')).rejects.toThrow(BusinessHasNoSubscriptionError);
    });

    it('refuses an unknown plan key', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      await createTestSubscription(businessId, 'starter');
      await expect(manuallyChangeBusinessPlan(businessId, 'not-a-real-plan')).rejects.toThrow('Unknown plan key');
    });
  });
});
