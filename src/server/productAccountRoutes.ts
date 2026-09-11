import { Router } from 'express';
import { z } from 'zod';
import { listAvailableProducts, listUserProductAccounts, provisionProductAccount, listAllProductAccounts, assignVertical, getControlPlaneStats, getAiUsageOverview } from '../services/productAccountService.js';
import {
  registerTrial,
  TrialAlreadyUsedOnboardingError,
  TrialPhoneAlreadyUsedOnboardingError,
  TrialProductUnavailableOnboardingError,
  RegistrationPausedOnboardingError,
  InvalidPhoneNumberError,
} from '../services/trialOnboardingService.js';
import { hasUsedTrial } from '../services/trialService.js';
import { isWeakPasswordError } from '../services/authService.js';
import { TrialRepository } from '../repositories/trialRepository.js';
import { ProductKeySchema } from '../domain/platform/productAccounts.js';
import { requireAuth, requireDeveloper, requireDeveloperAdmin, setSessionCookie, type AuthContext } from './authMiddleware.js';
import { UserRepository } from '../repositories/userRepository.js';
import { BusinessRepository } from '../repositories/businessRepository.js';
import type { Request } from 'express';
import { pool } from '../db/pool.js';
import { getSystemHealth } from '../services/systemHealthService.js';
import { SecurityAuditLogRepository } from '../repositories/securityAuditLogRepository.js';
import { PlatformSettingsRepository } from '../repositories/platformSettingsRepository.js';
import {
  isGooseFallbackEnabled, setGooseFallbackEnabled,
  isRegistrationPaused, setRegistrationPaused,
  isMaintenanceModeOn, setMaintenanceMode,
  getTrialDurationHours, setTrialDurationHours,
  getGeminiModelOverride, setGeminiModelOverride,
  getAiTokenTopupCatalogOverride, setAiTokenTopupCatalog,
  getAiMemoryTopupCatalogOverride, setAiMemoryTopupCatalog,
} from '../services/platform/platformConfigService.js';
import { TOPUP_CATALOG } from '../services/billing/aiTokenTopupService.js';
import { MEMORY_TOPUP_CATALOG } from '../services/billing/aiMemoryTopupService.js';
import { OpenClawCellRepository } from '../repositories/openclawCellRepository.js';
import { OpenClawSecurityAdvisoryRepository } from '../repositories/openclawSecurityAdvisoryRepository.js';
import { openclawCellService } from '../services/openclawCellService.js';
import { testGeminiConnection } from '../services/aiEngineStatusService.js';
import { verifyRecaptcha } from '../services/recaptchaService.js';

const router = Router();
const securityAuditLogRepository = new SecurityAuditLogRepository(pool);
const userRepository = new UserRepository(pool);
const businessRepository = new BusinessRepository(pool);
const platformSettingsRepository = new PlatformSettingsRepository(pool);
const productKey = ProductKeySchema;
const trials = new TrialRepository(pool);
const trialRegistrationSchema = z.object({ name: z.string().trim().min(1).max(200), email: z.string().trim().email(), phone: z.string().trim().min(3).max(50), password: z.string().min(1).max(200), productKey, recaptchaToken: z.string().optional() });
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

  const recaptcha = await verifyRecaptcha(parsed.data.recaptchaToken, req.ip ?? null);
  if (!recaptcha.ok) {
    await securityAuditLogRepository
      .record({ businessId: null, eventType: 'signup_recaptcha_failed', severity: 'warning', reason: recaptcha.reason, rawMetadata: { ipAddress: req.ip ?? null } })
      .catch(() => undefined);
    return res.status(400).json({ error: 'RECAPTCHA_FAILED', message: 'We could not verify this request. Please try again.' });
  }

  try {
    const { recaptchaToken: _recaptchaToken, ...registrationInput } = parsed.data;
    const result = await registerTrial({ ...registrationInput, device: deviceContextFrom(req) });
    setSessionCookie(req, res, result.token, 48 * 60 * 60);
    return res.status(201).json({ user: result.user, productAccountId: result.productAccountId, productKey: result.productKey, trial: { id: result.trialId, startsAt: result.startsAt, endsAt: result.endsAt, state: 'ACTIVE' } });
  } catch (error) {
    if (error instanceof RegistrationPausedOnboardingError) return res.status(403).json({ error: 'REGISTRATION_PAUSED', message: error.message });
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

/** The real detail behind the "Active trials" stat pill - every product_trials row, business name resolved server-side so the frontend needs no second lookup. */
router.get('/developer/trials', requireAuth, requireDeveloper, async (_req, res) => {
  const allTrials = await trials.listAll();
  return res.status(200).json({
    trials: allTrials.map((trial) => ({
      id: trial.id, email: trial.email, productKey: trial.productKey, state: trial.state,
      startsAt: trial.startsAt, endsAt: trial.endsAt, productAccountId: trial.productAccountId,
    })),
  });
});

/** The real detail behind the "Security events (24h)" stat pill - structural fields only, never raw message content. */
router.get('/developer/security-events', requireAuth, requireDeveloper, async (req, res) => {
  const hours = Number(req.query.hours ?? 24) || 24;
  const limitParam = Number(req.query.limit);
  // Bounded: an audit view must never be able to ask for an unbounded scan.
  const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 1000) : 200;

  const asString = (value: unknown): string | undefined => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text.length > 0 ? text : undefined;
  };

  const [events, facets] = await Promise.all([
    securityAuditLogRepository.listRecentAcrossPlatform(hours, limit, {
      severity: asString(req.query.severity),
      eventType: asString(req.query.eventType),
      businessId: asString(req.query.businessId),
      // Anything other than an explicit 'oldest' is newest-first, so a
      // malformed value degrades to the sensible default rather than erroring.
      sort: req.query.sort === 'oldest' ? 'oldest' : 'newest',
    }),
    // The values actually present in this window, so the filter UI can only
    // offer options that will really match something.
    securityAuditLogRepository.listRecentFacetsAcrossPlatform(hours),
  ]);

  return res.status(200).json({
    events: events.map((event) => ({
      id: event.id, eventType: event.eventType, severity: event.severity,
      businessId: event.businessId, businessName: event.businessName, createdAt: event.createdAt,
    })),
    facets,
  });
});

/** Section 116: the platform-wide events (plan_updated, plan_entitlement_updated, vertical_assigned) no business-scoped view (e.g. /api/workspace/activity-log) can ever see, since they carry no single business_id. */
router.get('/developer/audit-log', requireAuth, requireDeveloper, async (_req, res) => {
  const events = await securityAuditLogRepository.listPlatformEvents();
  return res.status(200).json({ events });
});

/**
 * Developer-tier management (migration 1002). Listing is open to any
 * developer (matching every other requireDeveloper route's own read
 * access); the two mutating routes below are the one deliberate
 * requireDeveloperAdmin-gated surface - only an Admin developer may
 * promote/demote another user or change an existing developer's tier.
 */
router.get('/developer/developers', requireAuth, requireDeveloper, async (_req, res) => {
  const developers = await userRepository.listDevelopers();
  return res.status(200).json({ developers: developers.map((user) => ({ id: user.id, email: user.email, displayName: user.displayName, developerTier: user.developerTier, createdAt: user.createdAt })) });
});

/** email, not userId - an Admin knows the person's real email, not their opaque id (which only appears once they're already a developer, i.e. after this call). */
const promoteDeveloperSchema = z.object({ email: z.string().trim().email(), tier: z.enum(['ADMIN', 'STANDARD']) });
router.post('/developer/developers', requireAuth, requireDeveloperAdmin, async (req, res) => {
  const parsed = promoteDeveloperSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT' });
  const auth = res.locals.auth as AuthContext;
  const target = await userRepository.findByEmail(parsed.data.email.toLowerCase());
  if (!target) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  const user = await userRepository.promoteToDeveloper(target.id, parsed.data.tier);
  if (!user) return res.status(404).json({ error: 'USER_NOT_FOUND' });
  await securityAuditLogRepository.record({ businessId: null, eventType: 'developer_promoted', rawMetadata: { targetUserId: user.id, tier: parsed.data.tier, promotedByUserId: auth.userId } });
  return res.status(200).json({ user: { id: user.id, email: user.email, developerTier: user.developerTier } });
});

const changeTierSchema = z.object({ tier: z.enum(['ADMIN', 'STANDARD']) });
router.patch('/developer/developers/:userId/tier', requireAuth, requireDeveloperAdmin, async (req, res) => {
  const parsed = changeTierSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT' });
  const auth = res.locals.auth as AuthContext;
  const user = await userRepository.setDeveloperTier(String(req.params['userId'] ?? ''), parsed.data.tier);
  if (!user) return res.status(404).json({ error: 'DEVELOPER_NOT_FOUND' });
  await securityAuditLogRepository.record({ businessId: null, eventType: 'developer_tier_changed', rawMetadata: { targetUserId: user.id, tier: parsed.data.tier, changedByUserId: auth.userId } });
  return res.status(200).json({ user: { id: user.id, email: user.email, developerTier: user.developerTier } });
});

router.delete('/developer/developers/:userId', requireAuth, requireDeveloperAdmin, async (req, res) => {
  const auth = res.locals.auth as AuthContext;
  const user = await userRepository.demoteToClient(String(req.params['userId'] ?? ''));
  if (!user) return res.status(404).json({ error: 'DEVELOPER_NOT_FOUND' });
  await securityAuditLogRepository.record({ businessId: null, eventType: 'developer_demoted', rawMetadata: { targetUserId: user.id, demotedByUserId: auth.userId } });
  return res.status(200).json({ user: { id: user.id, email: user.email, developerTier: user.developerTier } });
});

/** The one action that grants/revokes Part 3's businesses.tier_unrestricted exemption - Admin-only, since it's the actual mechanism that removes a business from every subscription/trial/entitlement gate. */
const tierUnrestrictedSchema = z.object({ unrestricted: z.boolean() });
router.patch('/developer/businesses/:businessId/tier-unrestricted', requireAuth, requireDeveloperAdmin, async (req, res) => {
  const parsed = tierUnrestrictedSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_INPUT' });
  const auth = res.locals.auth as AuthContext;
  const business = await businessRepository.setTierUnrestricted(String(req.params['businessId'] ?? ''), parsed.data.unrestricted);
  if (!business) return res.status(404).json({ error: 'BUSINESS_NOT_FOUND' });
  await securityAuditLogRepository.record({
    businessId: business.id,
    eventType: parsed.data.unrestricted ? 'business_tier_unrestricted_granted' : 'business_tier_unrestricted_revoked',
    rawMetadata: { grantedByUserId: auth.userId },
  });
  return res.status(200).json({ business: { id: business.id, name: business.name, tierUnrestricted: business.tierUnrestricted } });
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

/** A real, live test call against Gemini using the exact request shape a real reply uses (aiEngineStatusService.ts's own doc comment) - honors any developer-set model override, never just the env-var chain. */
router.post('/developer/test-gemini-connection', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json(await testGeminiConnection());
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

const openclawCellRepository = new OpenClawCellRepository(pool);
const openclawSecurityAdvisoryRepository = new OpenClawSecurityAdvisoryRepository(pool);

/**
 * Developer Master Control page: one generic pair of routes for every new
 * platform_settings-backed toggle (Section: Developer Master Control Page),
 * rather than a bespoke route per setting - the existing dedicated routes
 * (autonomy-kill-switch above, payment-providers in billingRoutes.ts) are
 * left untouched since they already work.
 */
const PLATFORM_CONFIG_KEYS = [
  'goose_fallback_enabled', 'registration_paused', 'maintenance_mode',
  'trial_duration_hours', 'gemini_model_override', 'ai_token_topup_catalog',
  'ai_memory_topup_catalog',
] as const;

router.get('/developer/platform-config', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json({
    gooseFallbackEnabled: await isGooseFallbackEnabled(),
    registrationPaused: await isRegistrationPaused(),
    maintenanceMode: await isMaintenanceModeOn(),
    trialDurationHours: await getTrialDurationHours(),
    geminiModelOverride: await getGeminiModelOverride(),
    aiTokenTopupCatalog: (await getAiTokenTopupCatalogOverride()) ?? TOPUP_CATALOG,
    aiMemoryTopupCatalog: (await getAiMemoryTopupCatalogOverride()) ?? MEMORY_TOPUP_CATALOG,
  });
});

const aiTokenTopupCatalogEntrySchema = z.object({
  tokens: z.number().int().positive(),
  priceCents: z.number().int().positive(),
  currency: z.string().trim().length(3),
});

const aiMemoryTopupCatalogEntrySchema = z.object({
  profiles: z.number().int().positive(),
  priceCents: z.number().int().positive(),
  currency: z.string().trim().length(3),
});

router.patch('/developer/platform-config/:key', requireAuth, requireDeveloper, async (req, res) => {
  const key = z.enum(PLATFORM_CONFIG_KEYS).safeParse(req.params.key);
  if (!key.success) return res.status(400).json({ error: 'UNKNOWN_PLATFORM_CONFIG_KEY' });
  const auth = res.locals.auth as AuthContext;

  switch (key.data) {
    case 'goose_fallback_enabled': {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_VALUE', details: parsed.error.flatten() });
      await setGooseFallbackEnabled(parsed.data.enabled, auth.userId);
      break;
    }
    case 'registration_paused': {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_VALUE', details: parsed.error.flatten() });
      await setRegistrationPaused(parsed.data.enabled, auth.userId);
      break;
    }
    case 'maintenance_mode': {
      const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_VALUE', details: parsed.error.flatten() });
      await setMaintenanceMode(parsed.data.enabled, auth.userId);
      break;
    }
    case 'trial_duration_hours': {
      const parsed = z.object({ hours: z.number().int().min(1).max(24 * 30) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_VALUE', details: parsed.error.flatten() });
      await setTrialDurationHours(parsed.data.hours, auth.userId);
      break;
    }
    case 'gemini_model_override': {
      const parsed = z.object({ model: z.string().trim().max(200).nullable() }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_VALUE', details: parsed.error.flatten() });
      await setGeminiModelOverride(parsed.data.model, auth.userId);
      break;
    }
    case 'ai_token_topup_catalog': {
      const parsed = z.record(z.string(), aiTokenTopupCatalogEntrySchema).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_VALUE', details: parsed.error.flatten() });
      await setAiTokenTopupCatalog(parsed.data, auth.userId);
      break;
    }
    case 'ai_memory_topup_catalog': {
      const parsed = z.record(z.string(), aiMemoryTopupCatalogEntrySchema).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'INVALID_VALUE', details: parsed.error.flatten() });
      await setAiMemoryTopupCatalog(parsed.data, auth.userId);
      break;
    }
  }

  await securityAuditLogRepository.record({
    businessId: null,
    eventType: 'platform_setting_updated',
    severity: key.data === 'maintenance_mode' || key.data === 'registration_paused' ? 'warning' : 'info',
    rawMetadata: { key: key.data, changedBy: auth.userId, body: req.body },
  });
  return res.status(200).json({ ok: true });
});

/**
 * Real secrets-configured checklist ("passwords: status only, not
 * editable" - see the Developer Master Control plan). Booleans only - no
 * value, masked or otherwise, ever leaves the server.
 */
router.get('/developer/secrets-status', requireAuth, requireDeveloper, async (_req, res) => {
  const configured = (value: string | undefined): boolean => Boolean(value?.trim());
  return res.status(200).json({
    secrets: [
      { name: 'GEMINI_API_KEY', configured: configured(process.env.GEMINI_API_KEY) },
      { name: 'GOOSE_SERVICE_API_KEY', configured: configured(process.env.GOOSE_SERVICE_API_KEY) },
      { name: 'OPENAI_API_KEY', configured: configured(process.env.OPENAI_API_KEY) },
      // The tool-capable gateway providers. Without these rows the Control
      // Plane's provider cards would report every one of them as "not
      // configured" no matter what the environment actually holds - a
      // status display that cannot tell the truth is worse than none.
      { name: 'GROQ_API_KEY', configured: configured(process.env.GROQ_API_KEY) },
      { name: 'CEREBRAS_API_KEY', configured: configured(process.env.CEREBRAS_API_KEY) },
      { name: 'MISTRAL_API_KEY', configured: configured(process.env.MISTRAL_API_KEY) },
      { name: 'OPENROUTER_API_KEY', configured: configured(process.env.OPENROUTER_API_KEY) },
      { name: 'GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET', configured: configured(process.env.GMAIL_CLIENT_ID) && configured(process.env.GMAIL_CLIENT_SECRET) },
      { name: 'ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET', configured: configured(process.env.ZOOM_CLIENT_ID) && configured(process.env.ZOOM_CLIENT_SECRET) },
      { name: 'OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET', configured: configured(process.env.OUTLOOK_CLIENT_ID) && configured(process.env.OUTLOOK_CLIENT_SECRET) },
      { name: 'BIMPAY_BRIDGE_SECRET', configured: configured(process.env.BIMPAY_BRIDGE_SECRET) },
      { name: 'PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_WEBHOOK_ID', configured: configured(process.env.PAYPAL_CLIENT_ID) && configured(process.env.PAYPAL_CLIENT_SECRET) && configured(process.env.PAYPAL_WEBHOOK_ID) },
    ],
  });
});

/**
 * OpenClaw is genuinely experimental and unwired today (no production code
 * path ever provisions a cell) - this gives honest, real visibility rather
 * than pretending it's a bigger surface than it is. clear-quarantine is
 * the one safe, already-implemented write action this subsystem has.
 */
router.get('/developer/openclaw/status', requireAuth, requireDeveloper, async (_req, res) => {
  const [cells, advisories, recentRuns] = await Promise.all([
    openclawCellRepository.listAll(),
    openclawSecurityAdvisoryRepository.listRecent(20),
    openclawSecurityAdvisoryRepository.listRecentRuns(1),
  ]);
  return res.status(200).json({
    mcpServerEnabled: process.env.OPENCLAW_MCP_SERVER_ENABLED === 'true',
    cellCount: cells.length,
    quarantinedCells: cells.filter((c) => c.securityStatus === 'SECURITY_QUARANTINED').map((c) => ({ businessId: c.businessId, cellId: c.cellId, quarantineReason: c.quarantineReason, quarantinedAt: c.quarantinedAt })),
    recentAdvisories: advisories,
    lastWatcherRun: recentRuns[0] ?? null,
  });
});

router.post('/developer/openclaw/cells/:businessId/clear-quarantine', requireAuth, requireDeveloper, async (req, res) => {
  const businessId = z.string().uuid().safeParse(req.params.businessId);
  if (!businessId.success) return res.status(400).json({ error: 'INVALID_BUSINESS_ID' });
  await openclawCellService.clearQuarantine(businessId.data);
  const auth = res.locals.auth as AuthContext;
  await securityAuditLogRepository.record({
    businessId: businessId.data,
    eventType: 'platform_setting_updated',
    rawMetadata: { key: 'openclaw_clear_quarantine', changedBy: auth.userId },
  });
  return res.status(200).json({ ok: true });
});

export { router as productAccountRouter };
