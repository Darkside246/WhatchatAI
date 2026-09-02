import type { Request, Response, NextFunction } from 'express';
import { parseCookies, serializeCookie } from './cookies.js';
import { validateSession } from '../services/authService.js';
import { hasPermission, type BusinessRole, type Permission } from '../domain/auth/permissions.js';
import type { PlatformRole, PublicUser } from '../repositories/userRepository.js';
import { ProductAccountRepository } from '../repositories/productAccountRepository.js';
import { getProductAccountAccess } from '../services/productAccountService.js';
import type { ProductKey } from '../domain/platform/productAccounts.js';
import { SubscriptionRepository } from '../repositories/subscriptionRepository.js';
import { pool } from '../db/pool.js';

export const SESSION_COOKIE_NAME = 'wc_session';
export interface AuthContext { userId: string; businessId: string; role: BusinessRole; platformRole: PlatformRole; sessionId: string; user: PublicUser; }
function isSecureRequest(req: Request): boolean { return req.secure || req.headers['x-forwarded-proto'] === 'https'; }
/**
 * maxAgeSeconds omitted (undefined) produces a true browser-session
 * cookie - cleared when the browser fully closes, even though the
 * server-side session token itself stays valid for its own TTL. This is
 * how "remember me" is implemented: checked -> a persistent Max-Age
 * cookie, unchecked -> this session-only cookie.
 */
export function setSessionCookie(req: Request, res: Response, token: string, maxAgeSeconds?: number): void {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, token, { httpOnly: true, secure: isSecureRequest(req), sameSite: 'Lax', ...(maxAgeSeconds !== undefined ? { maxAgeSeconds } : {}) }));
}
export function clearSessionCookie(req: Request, res: Response): void { res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, '', { httpOnly: true, secure: isSecureRequest(req), maxAgeSeconds: 0 })); }
export function readSessionToken(req: Request): string | null { return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME] ?? null; }

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readSessionToken(req);
  if (!token) return void res.status(401).json({ error: 'NOT_AUTHENTICATED' });
  const result = await validateSession(token);
  if (!result) { clearSessionCookie(req, res); return void res.status(401).json({ error: 'SESSION_EXPIRED' }); }
  res.locals.auth = { userId: result.user.id, businessId: result.membership.businessId, role: result.membership.role, platformRole: result.user.platformRole, sessionId: result.session.id, user: result.user } satisfies AuthContext;
  next();
}

export function requirePermission(permission: Permission) { return (req: Request, res: Response, next: NextFunction): void => { const auth = res.locals.auth as AuthContext | undefined; if (!auth) return void res.status(401).json({ error: 'NOT_AUTHENTICATED' }); if (!hasPermission(auth.role, permission)) return void res.status(403).json({ error: 'PERMISSION_DENIED', permission, role: auth.role }); next(); }; }

export function requireDeveloper(req: Request, res: Response, next: NextFunction): void {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) return void res.status(401).json({ error: 'NOT_AUTHENTICATED' });
  if (auth.platformRole !== 'DEVELOPER') return void res.status(403).json({ error: 'DEVELOPER_ACCESS_REQUIRED' });
  next();
}

const subscriptionRepository = new SubscriptionRepository(pool);

/**
 * Real, previously-missing gate for the few paid-feature surfaces
 * (invoicing, meeting-provider connections, email-account connections)
 * that had no entitlement or product-account check at all - only
 * requireAuth, meaning a business whose subscription had lapsed could
 * keep using them indefinitely. Every real business gets a live
 * subscription auto-provisioned at signup (businessBootstrapService.ts),
 * so this only ever blocks a genuinely cancelled/expired one - it does
 * not gate by plan tier or count (that's EntitlementService's job where
 * a real per-tier limit exists), just "is this business currently paying
 * for anything at all."
 */
export async function requireActiveSubscription(req: Request, res: Response, next: NextFunction): Promise<void> {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) return void res.status(401).json({ error: 'NOT_AUTHENTICATED' });
  if (auth.platformRole === 'DEVELOPER') return void next();
  const subscription = await subscriptionRepository.findLiveByBusiness(auth.businessId);
  if (!subscription) return void res.status(402).json({ error: 'NO_ACTIVE_SUBSCRIPTION' });
  next();
}

export function requireProductAccess(productKey: ProductKey, entitlementKey?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth) return void res.status(401).json({ error: 'NOT_AUTHENTICATED' });

    // Platform developers are not customer tenants. They may inspect and operate
    // product surfaces without requiring a customer product account, while all
    // CLIENT users continue through the strict account + entitlement checks below.
    if (auth.platformRole === 'DEVELOPER') {
      res.locals.productAccount = null;
      res.locals.developerProductAccess = { productKey, entitlementKey: entitlementKey ?? null, bypass: true };
      return void next();
    }

    const explicitAccountId = String(req.params.productAccountId ?? req.header('x-whatchatai-product-account-id') ?? '');
    const repository = new ProductAccountRepository(pool);
    const account = explicitAccountId ? await repository.findById(explicitAccountId) : await repository.findByBusinessAndProduct(auth.businessId, productKey);
    if (!account) return void res.status(403).json({ error: 'PRODUCT_ACCOUNT_REQUIRED', product: productKey });
    try {
      const access = await getProductAccountAccess(auth.userId, account.id);
      if (access.account.productKey !== productKey) return void res.status(403).json({ error: 'PRODUCT_ACCESS_DENIED' });
      if (!access.operationalAccess) return void res.status(402).json({ error: 'PRODUCT_ACCESS_RESTRICTED', product: productKey, accountStatus: access.account.status });
      if (entitlementKey && !access.entitlements.some((entitlement) => entitlement.key === entitlementKey && entitlement.enabled)) return void res.status(403).json({ error: 'ENTITLEMENT_REQUIRED', entitlement: entitlementKey });
      res.locals.productAccount = access;
      next();
    } catch (error) {
      if (error instanceof Error && (error.message === 'Product account not found.' || error.message === 'Product account membership not found.')) return void res.status(404).json({ error: 'PRODUCT_ACCOUNT_NOT_FOUND' });
      throw error;
    }
  };
}
