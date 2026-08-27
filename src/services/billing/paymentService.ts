import { createHmac, randomBytes } from 'node:crypto';
import { pool } from '../../db/pool.js';
import { ProductAccountRepository } from '../../repositories/productAccountRepository.js';
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

export async function verifyBiMPayTransfer(input: PaymentVerificationInput): Promise<{ paymentAttemptId: string; subscriptionId: string; productAccountId: string; status: 'ACTIVE' }> {
  const reference = input.checkoutReference.trim().toUpperCase();
  const currency = normaliseCurrency(input.currency);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query<{ id: string; product_account_id: string; subscription_id: string | null; amount_minor: string; currency: string; status: string; provider: string; provider_event_id: string | null }>(`SELECT id, product_account_id, subscription_id, amount_minor, currency, status, provider, provider_event_id FROM payment_attempts WHERE checkout_reference = $1 FOR UPDATE`, [reference]);
    const attempt = result.rows[0];
    if (!attempt) throw new PaymentReferenceNotFoundError('Checkout reference was not found.');
    if (attempt.provider !== input.provider) throw new PaymentVerificationError('Payment provider does not match the checkout.');
    if (attempt.status === 'VERIFIED') {
      if (attempt.provider_event_id === input.providerEventId) { await client.query('ROLLBACK'); return { paymentAttemptId: attempt.id, subscriptionId: attempt.subscription_id ?? '', productAccountId: attempt.product_account_id, status: 'ACTIVE' }; }
      throw new PaymentProviderEventAlreadyProcessedError('Payment attempt is already verified.');
    }
    if (attempt.currency !== currency || Number(attempt.amount_minor) !== input.amountMinor) {
      await client.query(`UPDATE payment_attempts SET status = 'REJECTED', rejected_at = now(), updated_at = now() WHERE id = $1`, [attempt.id]);
      await client.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, payload) VALUES ($1, $2, 'PAYMENT_REJECTED_AMOUNT_MISMATCH', 'PROVIDER_BRIDGE', $3)`, [attempt.product_account_id, attempt.id, JSON.stringify({ expectedMinor: attempt.amount_minor, receivedMinor: input.amountMinor, expectedCurrency: attempt.currency, receivedCurrency: currency, providerEventId: input.providerEventId })]);
      await client.query('COMMIT');
      throw new PaymentAmountMismatchError('Payment amount or currency does not match the checkout.');
    }
    if (attempt.subscription_id) await client.query(`UPDATE product_account_subscriptions SET status = 'ACTIVE', current_period_start = now(), current_period_end = CASE WHEN billing_interval = 'year' THEN now() + interval '1 year' WHEN billing_interval = 'one_time' THEN NULL ELSE now() + interval '1 month' END, activated_at = now(), updated_at = now() WHERE id = $1`, [attempt.subscription_id]);
    await client.query(`UPDATE payment_attempts SET status = 'VERIFIED', external_reference = $2, provider_event_id = $3, received_at = COALESCE($4, now()), verified_at = now(), updated_at = now() WHERE id = $1`, [attempt.id, input.checkoutReference.trim(), input.providerEventId, input.receivedAt ?? null]);
    await client.query(`UPDATE product_accounts SET status = 'ACTIVE', updated_at = now() WHERE id = $1`, [attempt.product_account_id]);
    await client.query(`UPDATE product_entitlements SET source = 'PLAN', expires_at = NULL, is_enabled = true WHERE product_account_id = $1 AND source = 'TRIAL'`, [attempt.product_account_id]);
    await client.query(`INSERT INTO product_account_provisioning_events (product_account_id, event_type) VALUES ($1, 'REACTIVATED')`, [attempt.product_account_id]);
    await client.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, payload) VALUES ($1, $2, 'PAYMENT_VERIFIED_ACCOUNT_ACTIVATED', 'PROVIDER_BRIDGE', $3)`, [attempt.product_account_id, attempt.id, JSON.stringify({ provider: input.provider, providerEventId: input.providerEventId })]);
    await client.query('COMMIT');
    return { paymentAttemptId: attempt.id, subscriptionId: attempt.subscription_id ?? '', productAccountId: attempt.product_account_id, status: 'ACTIVE' };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}

export async function submitPaymentProof(input: { userId: string; productAccountId: string; paymentAttemptId: string; proofUrl: string; note?: string }) {
  const membership = await pool.query(`SELECT 1 FROM business_memberships bm JOIN product_accounts pa ON pa.business_id = bm.business_id JOIN payment_attempts pay ON pay.product_account_id = pa.id WHERE pa.id = $1 AND bm.user_id = $2 AND bm.status = 'active' AND pay.id = $3 AND pay.status IN ('PENDING', 'RECEIVED')`, [input.productAccountId, input.userId, input.paymentAttemptId]);
  if (membership.rowCount !== 1) throw new BillingAccountNotFoundError('Payment attempt is not owned by this product account or is no longer reviewable.');
  const result = await pool.query<{ id: string; status: string }>(`INSERT INTO payment_proof_submissions (payment_attempt_id, product_account_id, submitted_by_user_id, proof_url, note) VALUES ($1, $2, $3, $4, $5) RETURNING id, status`, [input.paymentAttemptId, input.productAccountId, input.userId, input.proofUrl, input.note ?? null]);
  await pool.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, actor_user_id, payload) VALUES ($1, $2, 'PAYMENT_PROOF_SUBMITTED', 'CLIENT', $3, $4)`, [input.productAccountId, input.paymentAttemptId, input.userId, JSON.stringify({ proofSubmissionId: result.rows[0]?.id })]);
  return result.rows[0];
}
