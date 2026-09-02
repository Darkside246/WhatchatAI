import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  activateVerifiedPayment,
  createCheckout,
  verifyBiMPayTransfer,
  buildBiMPaySignature,
  PaymentAmountMismatchError,
} from '../src/services/billing/paymentService.js';
import { bimpayProvider } from '../src/services/billing/providers/bimpayProvider.js';
import { resetDatabase, createTestBusiness, createTestUser, createTestSubscription, createTestProductAccount } from './helpers.js';

const SECRET = 'test-bridge-secret';

describe('createCheckout (real Postgres)', () => {
  it('creates a real pending checkout with a payment attempt and audit event', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const productAccountId = await createTestProductAccount(businessId, userId);

    const checkout = await createCheckout({ userId, productAccountId, amountMinor: 12900, currency: 'BBD', billingInterval: 'month' });
    expect(checkout.status).toBe('PENDING');
    expect(checkout.checkoutReference).toMatch(/^SAAS-[0-9A-F]{6}$/);

    const sub = await pool.query<{ status: string }>('SELECT status FROM product_account_subscriptions WHERE id = $1', [checkout.subscriptionId]);
    expect(sub.rows[0]?.status).toBe('PENDING_PAYMENT');

    const attempt = await pool.query<{ status: string }>('SELECT status FROM payment_attempts WHERE id = $1', [checkout.paymentAttemptId]);
    expect(attempt.rows[0]?.status).toBe('PENDING');

    const audit = await pool.query<{ event_type: string }>('SELECT event_type FROM payment_audit_events WHERE payment_attempt_id = $1', [checkout.paymentAttemptId]);
    expect(audit.rows.map((r) => r.event_type)).toContain('CHECKOUT_CREATED');
  });
});

describe('activateVerifiedPayment (real Postgres)', () => {
  async function seedPendingCheckout(overrides: { amountMinor?: number; currency?: string } = {}) {
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const productAccountId = await createTestProductAccount(businessId, userId);
    const checkout = await createCheckout({
      userId,
      productAccountId,
      amountMinor: overrides.amountMinor ?? 12900,
      currency: overrides.currency ?? 'BBD',
    });
    await pool.query(
      `INSERT INTO product_entitlements (product_account_id, entitlement_key, is_enabled, source, expires_at) VALUES ($1, 'max_whatsapp_accounts', true, 'TRIAL', now() + interval '1 day')`,
      [productAccountId],
    );
    return { businessId, userId, productAccountId, checkout };
  }

  it('activates via the reference lookup, flips TRIAL entitlements to PLAN, and syncs the legacy subscription to ACTIVE', async () => {
    await resetDatabase();
    const { businessId, productAccountId, checkout } = await seedPendingCheckout();
    await createTestSubscription(businessId); // legacy row starts TRIALING

    const result = await activateVerifiedPayment(
      { by: 'reference', checkoutReference: checkout.checkoutReference },
      { provider: 'BIMPAY', amountMinor: checkout.amountMinor, currency: checkout.currency, providerEventId: 'evt-1', actorType: 'PROVIDER_BRIDGE' },
    );
    expect(result.status).toBe('ACTIVE');

    const account = await pool.query<{ status: string }>('SELECT status FROM product_accounts WHERE id = $1', [productAccountId]);
    expect(account.rows[0]?.status).toBe('ACTIVE');

    const sub = await pool.query<{ status: string }>('SELECT status FROM product_account_subscriptions WHERE id = $1', [checkout.subscriptionId]);
    expect(sub.rows[0]?.status).toBe('ACTIVE');

    const entitlement = await pool.query<{ source: string; expires_at: string | null }>(
      `SELECT source, expires_at FROM product_entitlements WHERE product_account_id = $1 AND entitlement_key = 'max_whatsapp_accounts'`,
      [productAccountId],
    );
    expect(entitlement.rows[0]?.source).toBe('PLAN');
    expect(entitlement.rows[0]?.expires_at).toBeNull();

    const legacy = await pool.query<{ status: string }>('SELECT status FROM subscriptions WHERE business_id = $1', [businessId]);
    expect(legacy.rows[0]?.status).toBe('ACTIVE');
  });

  it('activates identically via the attemptId lookup used by proof review, and records a traceable providerEventId instead of leaving it NULL', async () => {
    await resetDatabase();
    const { businessId, userId, productAccountId, checkout } = await seedPendingCheckout();
    await createTestSubscription(businessId);

    const result = await activateVerifiedPayment(
      { by: 'attemptId', paymentAttemptId: checkout.paymentAttemptId },
      { provider: 'BIMPAY', amountMinor: checkout.amountMinor, currency: checkout.currency, providerEventId: 'PROOF:fake-proof-id', actorType: 'DEVELOPER', actorUserId: userId },
    );
    expect(result.status).toBe('ACTIVE');
    expect(result.productAccountId).toBe(productAccountId);

    const attempt = await pool.query<{ provider_event_id: string | null; status: string }>('SELECT provider_event_id, status FROM payment_attempts WHERE id = $1', [checkout.paymentAttemptId]);
    expect(attempt.rows[0]?.status).toBe('VERIFIED');
    expect(attempt.rows[0]?.provider_event_id).toBe('PROOF:fake-proof-id');

    const legacy = await pool.query<{ status: string }>('SELECT status FROM subscriptions WHERE business_id = $1', [businessId]);
    expect(legacy.rows[0]?.status).toBe('ACTIVE');
  });

  it('is idempotent when the same providerEventId is replayed - no duplicate audit rows, same result', async () => {
    await resetDatabase();
    const { checkout } = await seedPendingCheckout();
    const input = { by: 'reference' as const, checkoutReference: checkout.checkoutReference };
    const payload = { provider: 'BIMPAY' as const, amountMinor: checkout.amountMinor, currency: checkout.currency, providerEventId: 'evt-replay', actorType: 'PROVIDER_BRIDGE' as const };

    const first = await activateVerifiedPayment(input, payload);
    const second = await activateVerifiedPayment(input, payload);
    expect(second).toEqual(first);

    const audits = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM payment_audit_events WHERE payment_attempt_id = $1 AND event_type = 'PAYMENT_VERIFIED_ACCOUNT_ACTIVATED'`,
      [checkout.paymentAttemptId],
    );
    expect(audits.rows[0]?.count).toBe('1');
  });

  it('rejects on amount mismatch, marks the attempt REJECTED, and leaves the legacy subscription untouched', async () => {
    await resetDatabase();
    const { businessId, checkout } = await seedPendingCheckout({ amountMinor: 12900, currency: 'BBD' });
    await createTestSubscription(businessId);

    await expect(
      activateVerifiedPayment(
        { by: 'reference', checkoutReference: checkout.checkoutReference },
        { provider: 'BIMPAY', amountMinor: 99999, currency: 'BBD', providerEventId: 'evt-mismatch', actorType: 'PROVIDER_BRIDGE' },
      ),
    ).rejects.toThrow(PaymentAmountMismatchError);

    const attempt = await pool.query<{ status: string }>('SELECT status FROM payment_attempts WHERE id = $1', [checkout.paymentAttemptId]);
    expect(attempt.rows[0]?.status).toBe('REJECTED');

    const legacy = await pool.query<{ status: string }>('SELECT status FROM subscriptions WHERE business_id = $1', [businessId]);
    expect(legacy.rows[0]?.status).toBe('TRIALING');
  });

  it('activates successfully even when the business has no legacy subscription row', async () => {
    await resetDatabase();
    const { checkout } = await seedPendingCheckout();
    // deliberately no createTestSubscription() call

    const result = await activateVerifiedPayment(
      { by: 'reference', checkoutReference: checkout.checkoutReference },
      { provider: 'BIMPAY', amountMinor: checkout.amountMinor, currency: checkout.currency, providerEventId: 'evt-no-legacy', actorType: 'PROVIDER_BRIDGE' },
    );
    expect(result.status).toBe('ACTIVE');
  });

  it('verifyBiMPayTransfer still activates via the reference lookup (thin wrapper over activateVerifiedPayment)', async () => {
    await resetDatabase();
    const { checkout } = await seedPendingCheckout();

    const result = await verifyBiMPayTransfer({
      provider: 'BIMPAY',
      checkoutReference: checkout.checkoutReference,
      amountMinor: checkout.amountMinor,
      currency: checkout.currency,
      providerEventId: 'evt-wrapper',
    });
    expect(result.status).toBe('ACTIVE');
  });
});

describe('bimpayProvider.verifyEvent (pure, no DB)', () => {
  function signedBody(overrides: Partial<{ checkoutReference: string; amountMinor: number; currency: string; providerEventId: string }> = {}) {
    const body = {
      checkoutReference: 'SAAS-A1B2C3',
      amountMinor: 12900,
      currency: 'BBD',
      providerEventId: 'bank-event-001',
      ...overrides,
    };
    const signature = buildBiMPaySignature({ provider: 'BIMPAY', ...body }, SECRET);
    return { body, signature };
  }

  it('verifies a correctly signed event', () => {
    const { body, signature } = signedBody();
    const result = bimpayProvider.verifyEvent({ body, headers: { 'x-bimpay-signature': signature }, secret: SECRET });
    expect(result.outcome).toBe('verified');
    if (result.outcome === 'verified') expect(result.checkoutReference).toBe('SAAS-A1B2C3');
  });

  it('rejects when the body is tampered with after signing', () => {
    const { body, signature } = signedBody();
    const tampered = { ...body, amountMinor: body.amountMinor + 1 };
    const result = bimpayProvider.verifyEvent({ body: tampered, headers: { 'x-bimpay-signature': signature }, secret: SECRET });
    expect(result).toEqual({ outcome: 'rejected', reason: 'INVALID_BIMPAY_SIGNATURE' });
  });

  it('rejects a missing signature header', () => {
    const { body } = signedBody();
    const result = bimpayProvider.verifyEvent({ body, headers: {}, secret: SECRET });
    expect(result).toEqual({ outcome: 'rejected', reason: 'INVALID_BIMPAY_SIGNATURE' });
  });

  it('rejects a structurally invalid body before checking the signature', () => {
    const result = bimpayProvider.verifyEvent({ body: { not: 'a valid event' }, headers: {}, secret: SECRET });
    expect(result).toEqual({ outcome: 'rejected', reason: 'INVALID_BIMPAY_EVENT' });
  });
});
