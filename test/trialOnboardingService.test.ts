import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  registerTrial,
  TrialAlreadyUsedOnboardingError,
  TrialPhoneAlreadyUsedOnboardingError,
  InvalidPhoneNumberError,
} from '../src/services/trialOnboardingService.js';
import { EntitlementService } from '../src/services/entitlementService.js';
import { resetDatabase } from './helpers.js';

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
