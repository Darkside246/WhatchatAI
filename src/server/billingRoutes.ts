import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireAuth, requireDeveloper, type AuthContext } from './authMiddleware.js';
import { buildBiMPaySignature, createCheckout, submitPaymentProof, verifyBiMPayTransfer } from '../services/billing/paymentService.js';
import { pool } from '../db/pool.js';

const router = Router();
const checkoutSchema = z.object({ productAccountId: z.string().uuid(), amountMinor: z.number().int().positive(), currency: z.string().trim().length(3).default('BBD'), billingInterval: z.enum(['month', 'year', 'one_time']).default('month') });
const proofSchema = z.object({ productAccountId: z.string().uuid(), paymentAttemptId: z.string().uuid(), proofUrl: z.string().url().max(2000), note: z.string().trim().max(2000).optional() });
const bridgeSchema = z.object({ checkoutReference: z.string().trim().min(4).max(64), amountMinor: z.number().int().positive(), currency: z.string().trim().length(3), providerEventId: z.string().trim().min(1).max(200), receivedAt: z.coerce.date().optional() });
const proofReviewSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(2000).optional() });

router.post('/checkout', requireAuth, async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CHECKOUT', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  try {
    const checkout = await createCheckout({ userId: auth.userId, ...parsed.data });
    return res.status(201).json({ checkout, instructions: checkout.provider === 'BIMPAY' ? { reference: checkout.checkoutReference, currency: checkout.currency, amountMinor: checkout.amountMinor, memoRequired: true, memoInstruction: `Enter ${checkout.checkoutReference} in the BiMPay transfer reference/memo.` } : undefined });
  } catch (error) { return res.status(404).json({ error: 'BILLING_ACCOUNT_NOT_FOUND', message: error instanceof Error ? error.message : String(error) }); }
});

router.post('/payment-proof', requireAuth, async (req, res) => {
  const parsed = proofSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PAYMENT_PROOF', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  try { return res.status(201).json({ proof: await submitPaymentProof({ userId: auth.userId, ...parsed.data }) }); }
  catch (error) { return res.status(404).json({ error: 'BILLING_ACCOUNT_NOT_FOUND', message: error instanceof Error ? error.message : String(error) }); }
});

/**
 * BiMPay automation bridge. This endpoint deliberately does not claim a native
 * BiMPay webhook. A bank/email automation bridge calls it after independently
 * receiving and parsing a confirmed transfer notification.
 */
router.post('/providers/bimpay/bridge', async (req, res) => {
  const secret = process.env.BIMPAY_BRIDGE_SECRET?.trim();
  if (!secret) return res.status(503).json({ error: 'BIMPAY_BRIDGE_NOT_CONFIGURED' });
  const parsed = bridgeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_BIMPAY_EVENT', details: parsed.error.flatten() });
  const receivedSignature = req.header('x-bimpay-signature') ?? '';
  const expectedSignature = buildBiMPaySignature({ provider: 'BIMPAY', ...parsed.data }, secret);
  const expected = Buffer.from(expectedSignature, 'utf8');
  const received = Buffer.from(receivedSignature, 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return res.status(401).json({ error: 'INVALID_BIMPAY_SIGNATURE' });
  try {
    const result = await verifyBiMPayTransfer({ provider: 'BIMPAY', ...parsed.data });
    return res.status(200).json({ ok: true, payment: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) return res.status(404).json({ error: 'PAYMENT_REFERENCE_NOT_FOUND', message });
    if (message.includes('amount') || message.includes('currency')) return res.status(409).json({ error: 'PAYMENT_MISMATCH', message });
    if (message.includes('already verified')) return res.status(409).json({ error: 'PAYMENT_ALREADY_VERIFIED', message });
    return res.status(500).json({ error: 'BIMPAY_VERIFICATION_FAILED', message });
  }
});

router.get('/developer/payment-proofs', requireAuth, requireDeveloper, async (_req, res) => {
  const { rows } = await pool.query(`SELECT id, payment_attempt_id, product_account_id, submitted_by_user_id, status, proof_url, note, reviewed_by_user_id, reviewed_at, created_at FROM payment_proof_submissions ORDER BY created_at DESC LIMIT 500`);
  return res.status(200).json({ proofs: rows });
});

router.post('/developer/payment-proofs/:proofId/review', requireAuth, requireDeveloper, async (req, res) => {
  const parsed = proofReviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PAYMENT_PROOF_REVIEW', details: parsed.error.flatten() });
  const proofId = z.string().uuid().safeParse(req.params.proofId);
  if (!proofId.success) return res.status(400).json({ error: 'INVALID_PROOF_ID' });
  const auth = res.locals.auth as AuthContext;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const proofResult = await client.query<{ id: string; payment_attempt_id: string; product_account_id: string; status: string; subscription_id: string | null }>(`SELECT p.id, p.payment_attempt_id, p.product_account_id, p.status, pa.subscription_id FROM payment_proof_submissions p JOIN payment_attempts pa ON pa.id = p.payment_attempt_id WHERE p.id = $1 AND p.product_account_id = pa.product_account_id FOR UPDATE`, [proofId.data]);
    const proof = proofResult.rows[0];
    if (!proof) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'PAYMENT_PROOF_NOT_FOUND' }); }
    if (proof.status !== 'PENDING_REVIEW') { await client.query('ROLLBACK'); return res.status(409).json({ error: 'PAYMENT_PROOF_ALREADY_REVIEWED' }); }
    if (parsed.data.decision === 'REJECT') {
      await client.query(`UPDATE payment_proof_submissions SET status = 'REJECTED', note = COALESCE($2, note), reviewed_by_user_id = $3, reviewed_at = now() WHERE id = $1`, [proof.id, parsed.data.note ?? null, auth.userId]);
      await client.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, actor_user_id, payload) VALUES ($1, $2, 'PAYMENT_PROOF_REJECTED', 'DEVELOPER', $3, $4)`, [proof.product_account_id, proof.payment_attempt_id, auth.userId, JSON.stringify({ note: parsed.data.note ?? null })]);
      await client.query('COMMIT');
      return res.status(200).json({ status: 'REJECTED' });
    }
    await client.query(`UPDATE payment_proof_submissions SET status = 'APPROVED', note = COALESCE($2, note), reviewed_by_user_id = $3, reviewed_at = now() WHERE id = $1`, [proof.id, parsed.data.note ?? null, auth.userId]);
    await client.query(`UPDATE payment_attempts SET status = 'VERIFIED', verified_at = now(), received_at = COALESCE(received_at, now()), updated_at = now() WHERE id = $1`, [proof.payment_attempt_id]);
    if (proof.subscription_id) await client.query(`UPDATE product_account_subscriptions SET status = 'ACTIVE', current_period_start = now(), current_period_end = CASE WHEN billing_interval = 'year' THEN now() + interval '1 year' WHEN billing_interval = 'one_time' THEN NULL ELSE now() + interval '1 month' END, activated_at = now(), updated_at = now() WHERE id = $1`, [proof.subscription_id]);
    await client.query(`UPDATE product_accounts SET status = 'ACTIVE', updated_at = now() WHERE id = $1`, [proof.product_account_id]);
    await client.query(`UPDATE product_entitlements SET source = 'PLAN', expires_at = NULL, is_enabled = true WHERE product_account_id = $1 AND source = 'TRIAL'`, [proof.product_account_id]);
    await client.query(`INSERT INTO product_account_provisioning_events (product_account_id, event_type) VALUES ($1, 'REACTIVATED')`, [proof.product_account_id]);
    await client.query(`INSERT INTO payment_audit_events (product_account_id, payment_attempt_id, event_type, actor_type, actor_user_id, payload) VALUES ($1, $2, 'PAYMENT_PROOF_APPROVED_ACCOUNT_ACTIVATED', 'DEVELOPER', $3, $4)`, [proof.product_account_id, proof.payment_attempt_id, auth.userId, JSON.stringify({ note: parsed.data.note ?? null })]);
    await client.query('COMMIT');
    return res.status(200).json({ status: 'APPROVED', accountStatus: 'ACTIVE' });
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
});

export { router as billingRouter };
