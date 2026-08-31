import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  registerTrial,
  TrialAlreadyUsedOnboardingError,
  TrialPhoneAlreadyUsedOnboardingError,
  InvalidPhoneNumberError,
} from '../src/services/trialOnboardingService.js';
import { EntitlementService } from '../src/services/entitlementService.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { WhatsAppConnectionEventRepository } from '../src/repositories/whatsappConnectionEventRepository.js';
import { resetDatabase, createTestAccount } from './helpers.js';

const device = { ipAddress: '127.0.0.1', userAgent: 'vitest-agent' };

function trialInput(overrides: Partial<{ name: string; email: string; phone: string }> = {}) {
  return {
    name: 'Test Owner',
    email: 'owner@example.com',
    phone: '+14155552671',
    productKey: 'property' as const,
    device,
    ...overrides,
  };
}

describe('registerTrial phone handling (real Postgres)', () => {
  it('stores the real phone number as an encrypted envelope, never plaintext or the raw input', async () => {
    await resetDatabase();
    const result = await registerTrial(trialInput());

    const { rows } = await pool.query<{ phone_number: string }>('SELECT phone_number FROM users WHERE id = $1', [result.user.id]);
    const stored = rows[0]?.phone_number;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe('+14155552671');
    expect(stored).not.toContain('4155552671');
    // A real JSON EncryptedEnvelope, not garbage.
    expect(() => JSON.parse(stored!)).not.toThrow();
    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveProperty('ciphertext');
    expect(parsed).toHaveProperty('iv');
    expect(parsed).toHaveProperty('authTag');
  });

  it('never returns the phone number in the trial response - toPublicUser omits it', async () => {
    await resetDatabase();
    const result = await registerTrial(trialInput());
    expect(result.user).not.toHaveProperty('phoneNumber');
  });

  it('rejects a second trial registration with the same normalized phone under a different email', async () => {
    await resetDatabase();
    await registerTrial(trialInput({ email: 'first@example.com', phone: '+1 415 555 2671' }));

    await expect(
      registerTrial(trialInput({ email: 'second@example.com', phone: '+14155552671' })),
    ).rejects.toThrow(TrialPhoneAlreadyUsedOnboardingError);
  });

  it('treats differently-formatted inputs for the same real number as the same number', async () => {
    await resetDatabase();
    await registerTrial(trialInput({ email: 'first@example.com', phone: '+1 (415) 555-2671' }));

    await expect(
      registerTrial(trialInput({ email: 'second@example.com', phone: '+14155552671' })),
    ).rejects.toThrow(TrialPhoneAlreadyUsedOnboardingError);
  });

  it('rejects an unparseable phone number before ever touching the database', async () => {
    await resetDatabase();
    await expect(registerTrial(trialInput({ phone: 'not-a-phone-number' }))).rejects.toThrow(InvalidPhoneNumberError);

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    expect(rows[0]?.count).toBe('0');
  });

  it('still enforces the existing email-uniqueness rule independent of phone', async () => {
    await resetDatabase();
    await registerTrial(trialInput({ email: 'owner@example.com', phone: '+14155552671' }));

    await expect(
      registerTrial(trialInput({ email: 'owner@example.com', phone: '+14155552672' })),
    ).rejects.toThrow(TrialAlreadyUsedOnboardingError);
  });

  it('permanently records a hash-only phone fingerprint with no reversible link back to the real number', async () => {
    await resetDatabase();
    await registerTrial(trialInput());

    const { rows } = await pool.query<{ phone_hash: string }>('SELECT phone_hash FROM trial_phone_fingerprints');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.phone_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  /**
   * Real regression coverage for "This business has no active subscription"
   * showing up for every trial business: registerTrial() used to create a
   * real product_accounts/product_entitlements row but never a subscriptions
   * row, so EntitlementService.checkEntitlement/checkCountLimit - which both
   * require subscriptionRepository.findLiveByBusiness() to return something
   * before even looking at entitlements - denied every gated action
   * unconditionally for every business this flow ever created.
   */
  it('provisions a real live TRIALING subscription so entitlement checks actually pass, not just the entitlement rows', async () => {
    await resetDatabase();
    const result = await registerTrial(trialInput());

    const { rows } = await pool.query<{ status: string; plan_id: string }>(
      'SELECT status, plan_id FROM subscriptions WHERE business_id = $1', [result.businessId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('TRIALING');

    const entitlements = new EntitlementService(pool);
    const check = await entitlements.canConnectWhatsAppAccount(result.businessId);
    expect(check.allowed).toBe(true);
  });
});

/**
 * Real regression coverage for a reported bug: a customer fills in the
 * trial form, the WhatsApp QR scan fails, and retrying with the same
 * email/phone got rejected with "already received a trial" even though
 * they never got a working account. A trial should only count as
 * genuinely consumed once the WhatsApp connection actually succeeds at
 * least once - until then, the same person retrying resumes their
 * pending signup instead of being blocked by it.
 */
describe('registerTrial abandonment window and resume (real Postgres)', () => {
  it('stamps a real scheduled_purge_at on a fresh trial business', async () => {
    await resetDatabase();
    const result = await registerTrial(trialInput());

    const { rows } = await pool.query<{ scheduled_purge_at: string | null }>(
      'SELECT scheduled_purge_at FROM businesses WHERE id = $1', [result.businessId],
    );
    expect(rows[0]?.scheduled_purge_at).not.toBeNull();
    expect(new Date(rows[0]!.scheduled_purge_at!).getTime()).toBeGreaterThan(Date.now());
  });

  it('resumes into the existing business when the identity has never connected WhatsApp, given the same email and phone', async () => {
    await resetDatabase();
    const first = await registerTrial(trialInput({ email: 'resume@example.com', phone: '+14155552671' }));

    const second = await registerTrial(trialInput({ email: 'resume@example.com', phone: '+14155552671' }));

    expect(second.businessId).toBe(first.businessId);
    expect(second.productAccountId).toBe(first.productAccountId);
    expect(second.trialId).toBe(first.trialId);
    expect(second.user.id).toBe(first.user.id);
    // The original trial clock keeps running - resuming is not a new trial.
    expect(second.startsAt).toBe(first.startsAt);
    expect(second.endsAt).toBe(first.endsAt);
    expect(second.token).not.toBe(first.token); // a genuinely new session was minted

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM businesses');
    expect(rows[0]?.count).toBe('1'); // no duplicate business was created
  });

  it('resume refreshes the abandonment window forward rather than leaving the original deadline', async () => {
    await resetDatabase();
    const first = await registerTrial(trialInput({ email: 'resume2@example.com', phone: '+14155552671' }));
    await pool.query(`UPDATE businesses SET scheduled_purge_at = now() + interval '1 hour' WHERE id = $1`, [first.businessId]);
    const before = (await pool.query<{ scheduled_purge_at: string }>(
      'SELECT scheduled_purge_at FROM businesses WHERE id = $1', [first.businessId],
    )).rows[0]!.scheduled_purge_at;

    await registerTrial(trialInput({ email: 'resume2@example.com', phone: '+14155552671' }));

    const after = (await pool.query<{ scheduled_purge_at: string }>(
      'SELECT scheduled_purge_at FROM businesses WHERE id = $1', [first.businessId],
    )).rows[0]!.scheduled_purge_at;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });

  /**
   * The security-critical case: without the phone check, anyone who
   * merely knows an email address that recently started a trial but
   * hasn't paired yet could resubmit this form and receive a fully
   * authenticated session for that account - a real account-takeover
   * path, since this flow has no password or email verification step at
   * all. Same generic error as a genuine repeat trial, deliberately - no
   * "phone mismatch" hint that would let an attacker confirm a pending
   * trial exists for a given email.
   */
  it('does not resume - and gives no hint why - when the same email is retried with a different phone', async () => {
    await resetDatabase();
    await registerTrial(trialInput({ email: 'resume3@example.com', phone: '+14155552671' }));

    await expect(
      registerTrial(trialInput({ email: 'resume3@example.com', phone: '+442071838750' })),
    ).rejects.toThrow(TrialAlreadyUsedOnboardingError);

    const { rows } = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM businesses');
    expect(rows[0]?.count).toBe('1'); // no new business was created either
  });

  it('still rejects re-registration once the business has actually connected WhatsApp, even with matching email and phone', async () => {
    await resetDatabase();
    const first = await registerTrial(trialInput({ email: 'connected@example.com', phone: '+14155552671' }));
    const accountId = await createTestAccount(first.businessId);
    await new WhatsAppConnectionEventRepository(pool).record({
      businessId: first.businessId,
      whatsappAccountId: accountId,
      eventType: 'connected',
      status: 'CONNECTED',
    });

    await expect(
      registerTrial(trialInput({ email: 'connected@example.com', phone: '+14155552671' })),
    ).rejects.toThrow(TrialAlreadyUsedOnboardingError);
  });

  it('clearScheduledPurge (the exact call persistConnectedAccount makes on a real first connect) clears the purge deadline', async () => {
    await resetDatabase();
    const result = await registerTrial(trialInput());
    const before = await pool.query<{ scheduled_purge_at: string | null }>(
      'SELECT scheduled_purge_at FROM businesses WHERE id = $1', [result.businessId],
    );
    expect(before.rows[0]?.scheduled_purge_at).not.toBeNull();

    const businesses = new BusinessRepository(pool);
    await businesses.clearScheduledPurge(result.businessId);

    const after = await pool.query<{ scheduled_purge_at: string | null }>(
      'SELECT scheduled_purge_at FROM businesses WHERE id = $1', [result.businessId],
    );
    expect(after.rows[0]?.scheduled_purge_at).toBeNull();
  });
});
