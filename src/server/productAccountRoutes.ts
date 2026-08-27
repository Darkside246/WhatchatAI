import { Router } from 'express';
import { z } from 'zod';
import { listAvailableProducts, listUserProductAccounts, provisionProductAccount, listAllProductAccounts } from '../services/productAccountService.js';
import { registerTrial, TrialAlreadyUsedOnboardingError, TrialProductUnavailableOnboardingError } from '../services/trialOnboardingService.js';
import { hasUsedTrial } from '../services/trialService.js';
import { ProductKeySchema } from '../domain/platform/productAccounts.js';
import { requireAuth, requireDeveloper, setSessionCookie, type AuthContext } from './authMiddleware.js';
import type { Request } from 'express';

const router = Router();
const productKey = ProductKeySchema;
const trialRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  email: z.string().trim().email(),
  phone: z.string().trim().min(3).max(50),
  productKey,
});

const deviceContextFrom = (req: Request) => ({ ipAddress: req.ip ?? null, userAgent: req.headers['user-agent'] ?? null });

// Public catalogue and trial eligibility endpoints used by the landing page.
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
    return res.status(201).json({
      user: result.user,
      productAccountId: result.productAccountId,
      productKey: result.productKey,
      trial: { id: result.trialId, startsAt: result.startsAt, endsAt: result.endsAt, state: 'ACTIVE' },
    });
  } catch (error) {
    if (error instanceof TrialAlreadyUsedOnboardingError) return res.status(409).json({ error: 'TRIAL_ALREADY_USED', message: error.message });
    if (error instanceof TrialProductUnavailableOnboardingError) return res.status(404).json({ error: 'PRODUCT_UNAVAILABLE', message: error.message });
    throw error;
  }
});

// Client product-account surfaces.
router.get('/product-accounts', requireAuth, async (_req, res) => {
  const auth = res.locals.auth as AuthContext;
  return res.status(200).json({ accounts: await listUserProductAccounts(auth.userId) });
});

router.post('/product-accounts', requireAuth, async (req, res) => {
  const parsed = z.object({ productKey, displayName: z.string().trim().min(1).max(200) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_PRODUCT_ACCOUNT', details: parsed.error.flatten() });
  const auth = res.locals.auth as AuthContext;
  return res.status(201).json({ account: await provisionProductAccount({ ownerUserId: auth.userId, ...parsed.data }) });
});

// Developer Control Plane surfaces. These are deliberately separate from client APIs.
router.get('/developer/product-accounts', requireAuth, requireDeveloper, async (_req, res) => {
  return res.status(200).json({ accounts: await listAllProductAccounts() });
});

export { router as productAccountRouter };
