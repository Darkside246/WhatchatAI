import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { requireAuth, requireDeveloper, type AuthContext } from './authMiddleware.js';
import { buildBiMPaySignature, createCheckout, submitPaymentProof, verifyBiMPayTransfer } from '../services/billing/paymentService.js';
import { ProductKeySchema } from '../domain/platform/productAccounts.js';

const router = Router();
const checkoutSchema = z.object({ productAccountId: z.string().uuid(), amountMinor: z.number().int().positive(), currency: z.string().trim().length(3).default('BBD'), billingInterval: z.enum(['month', 'year', 'one_time']).default('month') });
const proofSchema = z.object({ productAccountId: z.string().uuid(), paymentAttemptId: z.string().uuid(), proofUrl: z.string().url().max(2000), note: z.string().trim().max(2000).optional() });
const bridgeSchema = z.object({ checkoutReference: z.string().trim().min(4).max(64), amountMinor: z.number().int().positive(), currency: z.string().trim().length(3), providerEventId: z.string().trim().min(1).max(200), receivedAt: z.coerce.date().optional() });

router.post('/checkout', requireAuth, async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CHECKOUT', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  try {
    const checkout = await createCheckout({ userId: auth.userId, ...parsed.data });
    return res.status(201).json({ checkout, instructions: checkout.provider === 'BIMPAY' ? { reference: checkout.checkoutReference, currency: checkout.currency, amountMinor: checkout.amountMinor, memoRequired: true, memoInstruction: `Enter ${checkout.checkoutReference} in the BiMPay transfer reference/memo.` } : undefined });
  } catch (error) {
    return res.status(404).json({ error: 'BILLING_ACCOUNT_NOT_FOUND', message: error instanceof Error ? error.message : String(error) });
  }
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
  const receivedSignature = typeof req.header('x-bimpay-signature') === 'string' ? req.header('x-bimpay-signature')! : '';
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
  const { rows } = await import('../db/pool.js').then(({ pool }) => pool.query(`SELECT id, payment_attempt_id, product_account_id, submitted_by_user_id, status, proof_url, note, reviewed_by_user_id, reviewed_at, created_at FROM payment_proof_submissions ORDER BY created_at DESC LIMIT 500`));
  return res.status(200).json({ proofs: rows });
});

export { router as billingRouter };
