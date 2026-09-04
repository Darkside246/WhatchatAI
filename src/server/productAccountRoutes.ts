import { Router } from 'express';
import { z } from 'zod';
import { listAvailableProducts, listUserProductAccounts, provisionProductAccount, listAllProductAccounts, assignVertical, getControlPlaneStats, getAiUsageOverview } from '../services/productAccountService.js';
import {
  registerTrial,
  TrialAlreadyUsedOnboardingError,
  TrialPhoneAlreadyUsedOnboardingError,
  TrialProductUnavailableOnboardingError,
  InvalidPhoneNumberError,
} from '../services/trialOnboardingService.js';
import { hasUsedTrial } from '../services/trialService.js';
import { isWeakPasswordError } from '../services/authService.js';
import { TrialRepository } from '../repositories/trialRepository.js';
import { ProductKeySchema } from '../domain/platform/productAccounts.js';
import { requireAuth, requireDeveloper, setSessionCookie, type AuthContext } from './authMiddleware.js';
import type { Request } from 'express';
import { pool } from '../db/pool.js';
import { getSystemHealth } from '../services/systemHealthService.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { PlatformSettingsRepository } from '../repositories/platformSettingsRepository.js';

const router = Router();
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const platformSettingsRepository = new PlatformSettingsRepository(pool);
const productKey = ProductKeySchema;
const trials = new TrialRepository(pool);
const trialRegistrationSchema = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email(), phone: z.string().trim().min(3).max(50), password: z.string().min(1).max(200), productKey });
const deviceContextFrom = (req: Request) => ({ ipAddress: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

router.get('/products', async (_req, res) => res.status(200).json({ products: await listAvailableProducts() }));
router.get('/trials/eligibility', async (req, res) => {
  const email = typeof req.query.email === 'string' ? req.query.email : '';
  const parsed = z.string().email().safeParse(email.trim().toLowerCase());
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_EMAIL' });
  return res.status(200).json({ eligible: !(await hasUsedTrial(parsed.data)) });
});
router.post('/trials/register', async (req, res) => {
  const parsed = trialRegistrationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_TRIAL_REGISTRATION', details: parsed.error.flatten() });
  try {
    const result = await registerTrial({ ...parsed.data, device: deviceContextFrom(req) });
    setSessionCookie(req, res, result.token, 48 * 60 * 60);
    return res.status(201).json({ user: result.user, productAccountId: result.productAccountId, productKey: result.productKey, trial: { id: result.trialId, startsAt: result.startsAt, endsAt: result.endsAt, state: 'ACTIVE' } });
  } catch (error) {
    if (error instanceof TrialAlreadyUsedOnboardingError) return res.status(409).json({ error: 'TRIAL_ALREADY_USED', message: error.message });
    if (error instanceof TrialPhoneAlreadyUsedOnboardingError) return res.status(409).json({ error: 'TRIAL_ALREADY_USED', message: error.message });
    if (error instanceof InvalidPhoneNumberError) return res.status(400).json({ error: 'INVALID_PHONE_NUMBER', message: error.message });
    if (error instanceof TrialProductUnavailableOnboardingError) return res.status(404).json({ error: 'PRODUCT_UNAVAILABLE', message: error.message });
    if (isWeakPasswordError(error)) return res.status(400).json({ error: 'WEAK_PASSWORD', message: error.message });
    throw error;
  }
});

router.get('/product-accounts', requireAuth, async (_req, res) => { const auth = res.locals.auth as AuthContext; return res.status(200).json({ accounts: await listUserProductAccounts(auth.userId) }); });
router.post('/product-accounts', requireAuth, async (req, res) => {
  const parsed = z.object({ productKey, displayName: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PRODUCT_ACCOUNT', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  return res.status(201).json({ account: await provisionProductAccount({ ownerUserId: auth.userId, ...parsed.data }) });
});

router.get('/developer/product-accounts', requireAuth, requireDeveloper, async (_req, res) => res.status(200).json({ accounts: await listAllProductAccounts() }));
router.get('/developer/trials', requireAuth, requireDeveloper, async (_req, res) => res.status(200).json({ trials: await trials.listAll() }));

/** List all verticals available in the product catalog. */
router.get('/developer/verticals', requireAuth, requireDeveloper, async (_req, res) => {
  const { rows } = await pool.query<{ id: string; product_key: string; name: string; description: string; is_active: boolean }>(
    `SELECT id, product_key, name, description, is_active FROM product_catalog ORDER BY name`,
  );
  return res.status(200).json({ verticals: rows });
});

/** Assign (or re-assign) a vertical to a specific business account. */
router.post('/developer/accounts/:businessId/assign-vertical', requireAuth, requireDeveloper, async (req, res) => {
  const businessId = String(req.params['businessId'] ?? '');
  if (!z.string().uuid().safeParse(businessId).success) return res.status(400).json({ error: 'INVALID_BUSINESS_ID' });
  const parsed = z.object({ productKey: ProductKeySchema }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PRODUCT_KEY', details: parsed.error.flatten() });
  await assignVertical(businessId, parsed.data.productKey);
  // Section 116 (audit logging): a developer changing which vertical a
  // business is on is a real, consequential cross-tenant action with no
  // audit trail before this - business-scoped (unlike a plan-wide config
  // change), so it uses the affected business's own id.
  const auth = res.locals.auth as AuthContext;
  await securityAuditLogRepository.record({
    businessId,
    eventType: 'vertical_assigned',
    rawMetadata: { productKey: parsed.data.productKey, assignedBy: auth.userId },
  });
  return res.status(200).json({ ok: true, businessId, productKey: parsed.data.productKey });
});

router.get('/developer/control-plane-stats', requireAuth, requireDeveloper, async (_req, res) => {
  const stats = await getControlPlaneStats();
  return res.status(200).json({ stats });
});

/** Section 116: the platform-wide events (plan_updated, plan_entitlement_updated, vertical_assigned) no business-scoped view (e.g. /api/workspace/activity-log) can ever see, since they carry no single business_id. */
router.get('/developer/audit-log', requireAuth, requireDeveloper, async (_req, res) => {
  const events = await securityAuditLogRepository.listPlatformEvents();
  return res.status(200).json({ events });
});

/**
 * Aggregates the real /api/health/* checks already used by the deployment
 * probes into one authenticated, developer-only view - the previously
 * unmet gap where those endpoints existed but nothing in the actual admin
 * UI surfaced them. Runs the checks in parallel and never lets one
 * failing check take the others down with it.
 */
router.get('/developer/system-health', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json(await getSystemHealth());
});

router.get('/developer/ai-usage', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json(await getAiUsageOverview());
});

/**
 * Section 41-42 Phase 1's global kill switch - stops the autonomous
 * sweep (autonomousOpsService.ts) for every business platform-wide,
 * instantly, without touching a single business's own ai_actions_paused
 * or any agent's autonomy_level - reactive AI replies to real customer
 * messages keep working even with this on. Reuses the same
 * platform_settings live-toggle store as the Payment Providers panel.
 */
router.get('/developer/autonomy-kill-switch', requireAuth, requireDeveloper, async (_req, res) => {
  const setting = await platformSettingsRepository.get('autonomy_kill_switch');
  const enabled = setting ? (setting.value as { enabled?: unknown }).enabled === true : false;
  return res.status(200).json({ enabled });
});

router.patch('/developer/autonomy-kill-switch', requireAuth, requireDeveloper, async (req, res) => {
  const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_KILL_SWITCH_TOGGLE', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  await platformSettingsRepository.set('autonomy_kill_switch', { enabled: parsed.data.enabled }, auth.userId);
  await securityAuditLogRepository.record({
    businessId: null,
    eventType: 'platform_setting_updated',
    severity: parsed.data.enabled ? 'warning' : 'info',
    rawMetadata: { key: 'autonomy_kill_switch', changedBy: auth.userId, enabled: parsed.data.enabled },
  });
  return res.status(200).json({ enabled: parsed.data.enabled });
});

export { router as productAccountRouter };
