import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { requireAuth, requireDeveloper, type AuthContext } from './authMiddleware.js';
import { activateVerifiedPayment, createCheckout, submitPaymentProof } from '../services/billing/paymentService.js';
import { resolveProvider } from '../services/billing/providers/registry.js';
import { PaymentProviderSchema, type PaymentProvider } from '../domain/billing/payment.js';
import { PlanRepository } from '../repositories/planRepository.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { PlatformSettingsRepository } from '../repositories/platformSettingsRepository.js';
import { pool } from '../db/pool.js';

const router = Router();
const planRepository = new PlanRepository(pool);
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const platformSettingsRepository = new PlatformSettingsRepository(pool);
const PAYMENT_PROVIDER_KINDS = ['bimpay', 'paypal', 'wipay'] as const;
const checkoutSchema = z.object({ productAccountId: z.string().uuid(), provider: PaymentProviderSchema.optional(), amountMinor: z.number().int().positive(), currency: z.string().trim().length(3).default('BBD'), billingInterval: z.enum(['month', 'year', 'one_time']).default('month') });
const proofSchema = z.object({ productAccountId: z.string().uuid(), paymentAttemptId: z.string().uuid(), proofUrl: z.string().url().max(2000), note: z.string().trim().max(2000).optional() });
const proofReviewSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), note: z.string().trim().max(2000).optional() });
const updatePlanSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  priceMonthlyCents: z.number().int().min(0).optional(),
  priceYearlyCents: z.number().int().min(0).nullable().optional(),
  isActive: z.boolean().optional(),
});
const upsertEntitlementSchema = z.object({
  // null means unlimited (matches plan_entitlements.limit_value's own documented meaning) - never confused with 0, a real zero-access cap.
  limitValue: z.number().int().min(0).nullable(),
  isEnabled: z.boolean(),
});

router.post('/checkout', requireAuth, async (req, res) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_CHECKOUT', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  const providerKind = (parsed.data.provider ?? 'BIMPAY').toLowerCase();
  if (!(await isProviderUsable(providerKind))) return res.status(503).json({ error: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
  try {
    const checkoutInput: Parameters<typeof createCheckout>[0] = {
      userId: auth.userId,
      productAccountId: parsed.data.productAccountId,
      amountMinor: parsed.data.amountMinor,
      currency: parsed.data.currency,
      billingInterval: parsed.data.billingInterval,
    };
    if (parsed.data.provider !== undefined) checkoutInput.provider = parsed.data.provider;
    const checkout = await createCheckout(checkoutInput);
    const provider = resolveProvider(checkout.provider.toLowerCase());
    const instructions = provider ? await provider.buildCheckoutInstructions(checkout.checkoutReference, { amountMinor: checkout.amountMinor, currency: checkout.currency }) : undefined;
    return res.status(201).json({ checkout, instructions });
  } catch (error) { return res.status(404).json({ error: 'BILLING_ACCOUNT_NOT_FOUND', message: error instanceof Error ? error.message : String(error) }); }
});

/**
 * Only a provider a customer could actually complete a real payment
 * through - configured (real credentials present) AND not switched off
 * from the Control Plane. Feeds the checkout provider picker so BiMPay
 * never silently offers PayPal/WiPay before they're genuinely ready.
 */
router.get('/providers/available', requireAuth, async (_req, res) => {
  const available: string[] = [];
  for (const kind of PAYMENT_PROVIDER_KINDS) {
    if (await isProviderUsable(kind)) available.push(kind.toUpperCase());
  }
  return res.status(200).json({ providers: available });
});

router.post('/payment-proof', requireAuth, async (req, res) => {
  const parsed = proofSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PAYMENT_PROOF', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  try {
    const proofInput: Parameters<typeof submitPaymentProof>[0] = {
      userId: auth.userId,
      productAccountId: parsed.data.productAccountId,
      paymentAttemptId: parsed.data.paymentAttemptId,
      proofUrl: parsed.data.proofUrl,
    };
    if (parsed.data.note !== undefined) proofInput.note = parsed.data.note;
    return res.status(201).json({ proof: await submitPaymentProof(proofInput) });
  } catch (error) { return res.status(404).json({ error: 'BILLING_ACCOUNT_NOT_FOUND', message: error instanceof Error ? error.message : String(error) }); }
});

/**
 * Resolves a provider's own bridge/webhook secret - for BiMPay, the shared
 * HMAC secret; for PayPal, the webhook ID PayPal's verify-signature API
 * needs (see paypalProvider.ts's own doc comment - the OAuth client
 * id/secret it separately needs live are read directly from env inside
 * that file, not threaded through this generic string).
 */
function resolveProviderSecret(providerKind: string): string | undefined {
  if (providerKind === 'bimpay') return process.env.BIMPAY_BRIDGE_SECRET?.trim();
  if (providerKind === 'paypal') return process.env.PAYPAL_WEBHOOK_ID?.trim();
  return undefined;
}

/** Does this provider have the real credentials it needs to function at all - independent of whether a developer has since switched it off (see isProviderEnabled). WiPay is never configured until its real integration replaces the deliberate stub in wipayProvider.ts. */
export function isProviderConfigured(providerKind: string): boolean {
  if (providerKind === 'bimpay') return Boolean(process.env.BIMPAY_BRIDGE_SECRET?.trim());
  if (providerKind === 'paypal') return Boolean(process.env.PAYPAL_CLIENT_ID?.trim() && process.env.PAYPAL_CLIENT_SECRET?.trim() && process.env.PAYPAL_WEBHOOK_ID?.trim());
  return false;
}

/** The live Control Plane toggle (platform_settings) - defaults to enabled once a provider is configured, so setting up real credentials is enough on its own; a developer can still switch a configured provider off instantly without touching env vars or redeploying. */
export async function isProviderEnabled(providerKind: string): Promise<boolean> {
  const setting = await platformSettingsRepository.get(`payment_provider:${providerKind}`);
  if (!setting) return true;
  const value = setting.value as { enabled?: unknown };
  return value.enabled !== false;
}

export async function isProviderUsable(providerKind: string): Promise<boolean> {
  return resolveProvider(providerKind) !== undefined && isProviderConfigured(providerKind) && (await isProviderEnabled(providerKind));
}

/**
 * Shared handler for both the legacy BiMPay-specific bridge path and the
 * generalized per-provider webhook path below. A bank/email automation
 * bridge (or, later, a real processor's own webhook sender) calls this
 * after independently confirming a payment event; this endpoint
 * deliberately does not claim to be a native provider webhook receiver
 * for BiMPay, since none exists.
 */
async function handleProviderEvent(providerKind: string, req: Request, res: Response) {
  const provider = resolveProvider(providerKind);
  if (!provider) return res.status(404).json({ error: 'UNKNOWN_PAYMENT_PROVIDER' });
  if (!isProviderConfigured(providerKind) || !(await isProviderEnabled(providerKind))) return res.status(503).json({ error: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });
  const secret = resolveProviderSecret(providerKind);
  if (!secret) return res.status(503).json({ error: 'PAYMENT_PROVIDER_NOT_CONFIGURED' });

  const result = await provider.verifyEvent({ body: req.body, headers: req.headers, secret });
  // A real, signature-verified event the provider sent that this bridge
  // deliberately takes no action on (e.g. PayPal's ORDER.APPROVED) - a
  // genuine 200 acknowledgment, not an error, so the provider doesn't
  // retry it forever.
  if (result.outcome === 'ignored') return res.status(200).json({ ok: true, ignored: result.reason });
  if (result.outcome === 'rejected') {
    const status = result.reason === 'INVALID_BIMPAY_SIGNATURE' || result.reason === 'INVALID_PAYPAL_SIGNATURE' ? 401 : 400;
    return res.status(status).json({ error: result.reason });
  }

  try {
    const activation = await activateVerifiedPayment(
      { by: 'reference', checkoutReference: result.checkoutReference },
      {
        provider: providerKind.toUpperCase() as PaymentProvider,
        amountMinor: result.amountMinor,
        currency: result.currency,
        providerEventId: result.providerEventId,
        ...(result.receivedAt !== undefined ? { receivedAt: result.receivedAt } : {}),
        actorType: 'PROVIDER_BRIDGE',
      },
    );
    return res.status(200).json({ ok: true, payment: activation });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not found')) return res.status(404).json({ error: 'PAYMENT_REFERENCE_NOT_FOUND', message });
    if (message.includes('amount') || message.includes('currency')) return res.status(409).json({ error: 'PAYMENT_MISMATCH', message });
    if (message.includes('already verified')) return res.status(409).json({ error: 'PAYMENT_ALREADY_VERIFIED', message });
    return res.status(500).json({ error: 'PAYMENT_VERIFICATION_FAILED', message });
  }
}

router.post('/providers/bimpay/bridge', async (req, res) => { await handleProviderEvent('bimpay', req, res); });

router.post('/webhooks/:provider', async (req, res) => { await handleProviderEvent(req.params.provider, req, res); });

/**
 * Section 73-74: the live Control Plane view of every registered payment
 * provider - whether it has real credentials configured, and whether a
 * developer has switched it on/off. This is what lets PayPal/WiPay be
 * built and wired end-to-end today while staying invisible to a real
 * checkout until they're actually ready to go live.
 */
router.get('/developer/payment-providers', requireAuth, requireDeveloper, async (_req, res) => {
  const providers = await Promise.all(
    PAYMENT_PROVIDER_KINDS.map(async (kind) => ({ kind, configured: isProviderConfigured(kind), enabled: await isProviderEnabled(kind) })),
  );
  return res.status(200).json({ providers });
});

router.patch('/developer/payment-providers/:kind', requireAuth, requireDeveloper, async (req, res) => {
  const kind = z.enum(PAYMENT_PROVIDER_KINDS).safeParse(req.params.kind);
  if (!kind.success) return res.status(400).json({ error: 'UNKNOWN_PAYMENT_PROVIDER' });
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PAYMENT_PROVIDER_TOGGLE', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  const setting = await platformSettingsRepository.set(`payment_provider:${kind.data}`, { enabled: parsed.data.enabled }, auth.userId);
  await securityAuditLogRepository.record({
    businessId: null,
    eventType: 'platform_setting_updated',
    rawMetadata: { key: setting.key, changedBy: auth.userId, enabled: parsed.data.enabled },
  });
  return res.status(200).json({ setting });
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
    const proofResult = await client.query<{ id: string; payment_attempt_id: string; product_account_id: string; status: string; provider: PaymentProvider; amount_minor: string; currency: string }>(`SELECT p.id, p.payment_attempt_id, p.product_account_id, p.status, pa.provider, pa.amount_minor, pa.currency FROM payment_proof_submissions p JOIN payment_attempts pa ON pa.id = p.payment_attempt_id WHERE p.id = $1 AND p.product_account_id = pa.product_account_id FOR UPDATE`, [proofId.data]);
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
    // Pass the attempt's own stored amount/currency straight back into
    // itself - this path is approving a specific already-known attempt
    // by id, not re-verifying an externally-claimed amount, so the
    // shared function's mismatch-check becomes a harmless no-op here.
    // providerEventId is namespaced PROOF:<id> so this activation is
    // traceable to the proof that caused it (previously left NULL).
    // activateVerifiedPayment writes its own PAYMENT_VERIFIED_ACCOUNT_ACTIVATED
    // audit event (actor_type='DEVELOPER' here) - no separate event needed.
    await activateVerifiedPayment(
      { by: 'attemptId', paymentAttemptId: proof.payment_attempt_id },
      { provider: proof.provider, amountMinor: Number(proof.amount_minor), currency: proof.currency, providerEventId: `PROOF:${proof.id}`, actorType: 'DEVELOPER', actorUserId: auth.userId },
      { client },
    );
    await client.query('COMMIT');
    return res.status(200).json({ status: 'APPROVED', accountStatus: 'ACTIVE' });
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
});

/**
 * Section 34-40 (Token economy) / general plan administration - before
 * this, every plan's price and every entitlement limit (agents per tier,
 * AI tokens per month, etc.) was only ever changeable by hand-editing a
 * migration file, despite migration 025's own seed comment promising
 * "illustrative starting values... the business can change". This is that
 * promised admin surface, developer-only like every other cross-tenant
 * control in this router.
 */
router.get('/developer/plans', requireAuth, requireDeveloper, async (_req, res) => {
  const plans = await planRepository.listAll();
  const withEntitlements = await Promise.all(
    plans.map(async (plan) => ({ ...plan, entitlements: await planRepository.listEntitlements(plan.id) })),
  );
  return res.status(200).json({ plans: withEntitlements });
});

router.patch('/developer/plans/:planId', requireAuth, requireDeveloper, async (req, res) => {
  const planId = z.string().uuid().safeParse(req.params.planId);
  if (!planId.success) return res.status(400).json({ error: 'INVALID_PLAN_ID' });
  const parsed = updatePlanSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PLAN_UPDATE', details: parsed.error.flatten() });
  const updated = await planRepository.updatePlan(planId.data, parsed.data);
  if (!updated) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });
  // Section 116 (audit logging): this changes real billing terms for every
  // business subscribed to this plan - platform-wide, so businessId is
  // null (migration 974), not the acting developer's own business.
  const auth = res.locals.auth as AuthContext;
  await securityAuditLogRepository.record({
    businessId: null,
    eventType: 'plan_updated',
    rawMetadata: { planId: planId.data, changedBy: auth.userId, changes: parsed.data },
  });
  return res.status(200).json({ plan: updated });
});

router.put('/developer/plans/:planId/entitlements/:entitlementKey', requireAuth, requireDeveloper, async (req, res) => {
  const planId = z.string().uuid().safeParse(req.params.planId);
  if (!planId.success) return res.status(400).json({ error: 'INVALID_PLAN_ID' });
  const entitlementKey = z.string().trim().min(1).max(100).safeParse(req.params.entitlementKey);
  if (!entitlementKey.success) return res.status(400).json({ error: 'INVALID_ENTITLEMENT_KEY' });
  const parsed = upsertEntitlementSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_ENTITLEMENT_UPDATE', details: parsed.error.flatten() });
  const plan = await planRepository.findById(planId.data);
  if (!plan) return res.status(404).json({ error: 'PLAN_NOT_FOUND' });
  const entitlement = await planRepository.upsertEntitlement(planId.data, entitlementKey.data, parsed.data);
  const auth = res.locals.auth as AuthContext;
  await securityAuditLogRepository.record({
    businessId: null,
    eventType: 'plan_entitlement_updated',
    rawMetadata: { planId: planId.data, entitlementKey: entitlementKey.data, changedBy: auth.userId, changes: parsed.data },
  });
  return res.status(200).json({ entitlement });
});

export { router as billingRouter };
