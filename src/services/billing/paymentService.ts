import { createHmac, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../../db/pool.js';
import { ProductAccountRepository } from '../../repositories/productAccountRepository.js';
import { SubscriptionRepository } from '../../repositories/subscriptionRepository.js';
import type { Checkout, PaymentProvider, PaymentVerificationInput } from '../../domain/billing/payment.js';

const accounts = new ProductAccountRepository(pool);
const BIMPAY_PREFIX = 'SAAS';
function normaliseCurrency(value: string): string { return value.trim().toUpperCase(); }
export function generateCheckoutReference(prefix = BIMPAY_PREFIX): string { return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`; }
export function buildBiMPaySignature(input: Omit<PaymentVerificationInput, 'receivedAt'>, secret: string): string {
  const canonical = [input.provider, input.checkoutReference.trim().toUpperCase(), input.amountMinor, normaliseCurrency(input.currency), input.providerEventId].join(':');
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
export class BillingAccountNotFoundError extends Error {}
export class PaymentVerificationError extends Error {}
export class PaymentAmountMismatchError extends PaymentVerificationError {}
export class PaymentReferenceNotFoundError extends PaymentVerificationError {}
export class PaymentProviderEventAlreadyProcessedError extends PaymentVerificationError {}

export async function createCheckout(input: { userId: string; productAccountId: string; provider?: PaymentProvider; amountMinor: number; currency?: string; billingInterval?: 'month' | 'year' | 'one_time'; }): Promise<Checkout> {
  const account = await accounts.findById(input.productAccountId);
  if (!account) throw new BillingAccountNotFoundError('Product account not found.');
  const membership = await pool.query('SELECT 1 FROM business_memberships WHERE business_id = $1 AND user_id = $2 AND status = $3', [account.businessId, input.userId, 'active']);
  if (membership.rowCount !== 1) throw new BillingAccountNotFoundError('Product account membership not found.');
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) throw new PaymentVerificationError('Amount must be a positive integer in minor currency units.');
  const provider = input.provider ?? 'BIMPAY';
  const currency = normaliseCurrency(input.currency ?? 'BBD');
  const billingInterval = input.billingInterval ?? 'month';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const subscription = await client.query<{ id: string }>(`INSERT INTO product_account_subscriptions (product_account_id, product_id, status, currency, amount_minor, billing_interval) VALUES ($1, $2, 'PENDING_PAYMENT', $3, $4, $5) ON CONFLICT (product_account_id) WHERE status IN ('PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE') DO UPDATE SET amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, billing_interval = EXCLUDED.billing_interval, status = 'PENDING_PAYMENT', updated_at = now() RETURNING id`, [input.productAccountId, account.productId, currency, input.amountMinor, billingInterval]);
    const subscriptionId = subscription.rows[0]?.id;
    if (!subscriptionId) throw new Error('Subscription creation failed.');
    const reference = generateCheckoutReference();
    const attempt = await client.query<{ id: string }>(`INSERT INTO payment_attempts (product_account_id, subscription_id, provider, status, currency, amount_minor, checkout_reference) VALUES ($1, $2, $3, 'PENDING', $4, $5, $6) RETURNING id`, [input.productAccountId, subscriptionId, provider, currency, input.amountMinor, reference]);
    const paymentAttemptId = attempt.rows[0]?.id;
    if (!paymentAttemptId) throw new Error('Payment attempt creation failed.');
    await client.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, actor_user_id, payload) VALUES ($1, $2, 'CHECKOUT_CREATED', 'CLIENT', $3, $4)`, [input.productAccountId, paymentAttemptId, input.userId, JSON.stringify({ provider, amountMinor: input.amountMinor, currency, billingInterval })]);
    await client.query('COMMIT');
    return { paymentAttemptId, subscriptionId, checkoutReference: reference, provider, currency, amountMinor: input.amountMinor, status: 'PENDING' };
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}

export type ActivationLookup = { by: 'reference'; checkoutReference: string } | { by: 'attemptId'; paymentAttemptId: string };
export type ActivationActorType = 'PROVIDER_BRIDGE' | 'DEVELOPER';
export interface ActivateVerifiedPaymentInput {
  provider: PaymentProvider;
  amountMinor: number;
  currency: string;
  providerEventId: string;
  receivedAt?: Date;
  actorType: ActivationActorType;
  actorUserId?: string;
}

/**
 * Single shared "mark a payment attempt verified and activate the
 * account" path, used by both the signed-bridge/webhook flow and the
 * developer proof-review approval flow. Previously each duplicated this
 * 5-table sequence inline, so a future change to one would not
 * automatically apply to the other.
 *
 * Pass `options.client` when the caller already owns an open transaction
 * (e.g. the proof-review route, which must commit or roll back the proof
 * status change atomically with this activation) - in that case this
 * function issues no BEGIN/COMMIT/ROLLBACK/release of its own and the
 * caller is responsible for all of that. Otherwise it manages its own
 * connection and transaction end-to-end.
 */
export async function activateVerifiedPayment(
  lookup: ActivationLookup,
  input: ActivateVerifiedPaymentInput,
  options: { client?: PoolClient } = {},
): Promise<{ paymentAttemptId: string; subscriptionId: string; productAccountId: string; status: 'ACTIVE' }> {
  const currency = normaliseCurrency(input.currency);
  const ownsTransaction = !options.client;
  const client = options.client ?? (await pool.connect());
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const selectQuery =
      lookup.by === 'reference'
        ? { sql: `SELECT id, product_account_id, subscription_id, amount_minor, currency, status, provider, provider_event_id FROM payment_attempts WHERE checkout_reference = $1 FOR UPDATE`, param: lookup.checkoutReference.trim().toUpperCase() }
        : { sql: `SELECT id, product_account_id, subscription_id, amount_minor, currency, status, provider, provider_event_id FROM payment_attempts WHERE id = $1 FOR UPDATE`, param: lookup.paymentAttemptId };
    const result = await client.query<{ id: string; product_account_id: string; subscription_id: string | null; amount_minor: string; currency: string; status: string; provider: string; provider_event_id: string | null }>(selectQuery.sql, [selectQuery.param]);
    const attempt = result.rows[0];
    if (!attempt) throw new PaymentReferenceNotFoundError('Payment attempt was not found.');
    if (attempt.provider !== input.provider) throw new PaymentVerificationError('Payment provider does not match the checkout.');
    if (attempt.status === 'VERIFIED') {
      if (attempt.provider_event_id === input.providerEventId) { if (ownsTransaction) await client.query('ROLLBACK'); return { paymentAttemptId: attempt.id, subscriptionId: attempt.subscription_id ?? '', productAccountId: attempt.product_account_id, status: 'ACTIVE' }; }
      throw new PaymentProviderEventAlreadyProcessedError('Payment attempt is already verified.');
    }
    if (attempt.currency !== currency || Number(attempt.amount_minor) !== input.amountMinor) {
      await client.query(`UPDATE payment_attempts SET status = 'REJECTED', rejected_at = now(), updated_at = now() WHERE id = $1`, [attempt.id]);
      await client.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, payload) VALUES ($1, $2, 'PAYMENT_REJECTED_AMOUNT_MISMATCH', $3, $4)`, [attempt.product_account_id, attempt.id, input.actorType, JSON.stringify({ expectedMinor: attempt.amount_minor, receivedMinor: input.amountMinor, expectedCurrency: attempt.currency, receivedCurrency: currency, providerEventId: input.providerEventId })]);
      if (ownsTransaction) await client.query('COMMIT');
      throw new PaymentAmountMismatchError('Payment amount or currency does not match the checkout.');
    }
    if (attempt.subscription_id) await client.query(`UPDATE product_account_subscriptions SET status = 'ACTIVE', current_period_start = now(), current_period_end = CASE WHEN billing_interval = 'year' THEN now() + interval '1 year' WHEN billing_interval = 'one_time' THEN NULL ELSE now() + interval '1 month' END, activated_at = now(), updated_at = now() WHERE id = $1`, [attempt.subscription_id]);
    await client.query(`UPDATE payment_attempts SET status = 'VERIFIED', provider_event_id = $2, received_at = COALESCE($3, now()), verified_at = now(), updated_at = now() WHERE id = $1`, [attempt.id, input.providerEventId, input.receivedAt ?? null]);
    await client.query(`UPDATE product_accounts SET status = 'ACTIVE', updated_at = now() WHERE id = $1`, [attempt.product_account_id]);
    await client.query(`UPDATE product_entitlements SET source = 'PLAN', expires_at = NULL, is_enabled = true WHERE product_account_id = $1 AND source = 'TRIAL'`, [attempt.product_account_id]);
    await client.query(`INSERT INTO product_account_provisioning_events (product_account_id, event_type) VALUES ($1, 'REACTIVATED')`, [attempt.product_account_id]);
    await client.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, actor_user_id, payload) VALUES ($1, $2, 'PAYMENT_VERIFIED_ACCOUNT_ACTIVATED', $3, $4, $5)`, [attempt.product_account_id, attempt.id, input.actorType, input.actorUserId ?? null, JSON.stringify({ provider: input.provider, providerEventId: input.providerEventId })]);

    // Legacy-schema sync: a verified payment here previously never advanced
    // the separate plans/subscriptions table's status past TRIALING, even
    // though that's what BillingRoute.tsx displays and what
    // EntitlementService gates agents/campaigns/funnels against. Not every
    // business has a legacy subscription row, so this is best-effort and
    // never fails the activation.
    const account = await new ProductAccountRepository(client).findById(attempt.product_account_id);
    if (account) {
      const legacySubscriptions = new SubscriptionRepository(client);
      const liveSubscription = await legacySubscriptions.findLiveByBusiness(account.businessId);
      if (liveSubscription) await legacySubscriptions.updateStatus(liveSubscription.id, 'ACTIVE');
    }

    if (ownsTransaction) await client.query('COMMIT');
    return { paymentAttemptId: attempt.id, subscriptionId: attempt.subscription_id ?? '', productAccountId: attempt.product_account_id, status: 'ACTIVE' };
  } catch (error) {
    if (ownsTransaction) { try { await client.query('ROLLBACK'); } catch {} }
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

export async function verifyBiMPayTransfer(input: PaymentVerificationInput): Promise<{ paymentAttemptId: string; subscriptionId: string; productAccountId: string; status: 'ACTIVE' }> {
  return activateVerifiedPayment(
    { by: 'reference', checkoutReference: input.checkoutReference },
    {
      provider: input.provider,
      amountMinor: input.amountMinor,
      currency: input.currency,
      providerEventId: input.providerEventId,
      ...(input.receivedAt !== undefined ? { receivedAt: input.receivedAt } : {}),
      actorType: 'PROVIDER_BRIDGE',
    },
  );
}

export async function submitPaymentProof(input: { userId: string; productAccountId: string; paymentAttemptId: string; proofUrl: string; note?: string }) {
  const membership = await pool.query(`SELECT 1 FROM business_memberships bm JOIN product_accounts pa ON pa.business_id = bm.business_id JOIN payment_attempts pay ON pay.product_account_id = pa.id WHERE pa.id = $1 AND bm.user_id = $2 AND bm.status = 'active' AND pay.id = $3 AND pay.status IN ('PENDING', 'RECEIVED')`, [input.productAccountId, input.userId, input.paymentAttemptId]);
  if (membership.rowCount !== 1) throw new BillingAccountNotFoundError('Payment attempt is not owned by this product account or is no longer reviewable.');
  const result = await pool.query<{ id: string; status: string }>(`INSERT INTO payment_proof_submissions (payment_attempt_id, product_account_id, submitted_by_user_id, proof_url, note) VALUES ($1, $2, $3, $4, $5) RETURNING id, status`, [input.paymentAttemptId, input.productAccountId, input.userId, input.proofUrl, input.note ?? null]);
  await pool.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, actor_user_id, payload) VALUES ($1, $2, 'PAYMENT_PROOF_SUBMITTED', 'CLIENT', $3, $4)`, [input.productAccountId, input.paymentAttemptId, input.userId, JSON.stringify({ proofSubmissionId: result.rows[0]?.id })]);
  return result.rows[0];
}
