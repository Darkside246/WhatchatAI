import type { Request, Response, NextFunction } from 'express';
import { parseCookies, serializeCookie } from './cookies.js';
import { validateSession } from '../services/authService.js';
import { hasPermission, type BusinessRole, type Permission } from '../domain/auth/permissions.js';
import type { PlatformRole, PublicUser } from '../repositories/userRepository.js';
import { getProductAccountAccess } from '../services/productAccountService.js';
import type { ProductKey } from '../domain/platform/productAccounts.js';

export const SESSION_COOKIE_NAME = 'wc_session';

export interface AuthContext {
  userId: string;
  businessId: string;
  role: BusinessRole;
  platformRole: PlatformRole;
  sessionId: string;
  user: PublicUser;
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers['x-forwarded-proto'] === 'https';
}

export function setSessionCookie(req: Request, res: Response, token: string, maxAgeSeconds: number): void {
  res.setHeader(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE_NAME, token, { httpOnly: true, secure: isSecureRequest(req), sameSite: 'Lax', maxAgeSeconds }),
  );
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.setHeader('Set-Cookie', serializeCookie(SESSION_COOKIE_NAME, '', { httpOnly: true, secure: isSecureRequest(req), maxAgeSeconds: 0 }));
}

export function readSessionToken(req: Request): string | null {
  const cookies = parseCookies(req.headers.cookie);
  return cookies[SESSION_COOKIE_NAME] ?? null;
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = readSessionToken(req);
  if (!token) {
    res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return;
  }

  const result = await validateSession(token);
  if (!result) {
    clearSessionCookie(req, res);
    res.status(401).json({ error: 'SESSION_EXPIRED' });
    return;
  }

  const auth: AuthContext = {
    userId: result.user.id,
    businessId: result.membership.businessId,
    role: result.membership.role,
    platformRole: result.user.platformRole,
    sessionId: result.session.id,
    user: result.user,
  };
  res.locals.auth = auth;
  next();
}

export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth) {
      res.status(401).json({ error: 'NOT_AUTHENTICATED' });
      return;
    }
    if (!hasPermission(auth.role, permission)) {
      res.status(403).json({ error: 'PERMISSION_DENIED', permission, role: auth.role });
      return;
    }
    next();
  };
}

export function requireDeveloper(req: Request, res: Response, next: NextFunction): void {
  const auth = res.locals.auth as AuthContext | undefined;
  if (!auth) {
    res.status(401).json({ error: 'NOT_AUTHENTICATED' });
    return;
  }
  if (auth.platformRole !== 'DEVELOPER') {
    res.status(403).json({ error: 'DEVELOPER_ACCESS_REQUIRED' });
    return;
  }
  next();
}

/**
 * Product routes use this boundary in addition to normal authentication and
 * business permissions. The account id is supplied by the route parameter,
 * then ownership and product identity are checked against PostgreSQL. A
 * developer still bypasses product ownership only on explicitly developer
 * routes, never by altering a client request.
 */
export function requireProductAccess(productKey: ProductKey, entitlementKey?: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const auth = res.locals.auth as AuthContext | undefined;
    if (!auth) {
      res.status(401).json({ error: 'NOT_AUTHENTICATED' });
      return;
    }

    const accountId = String(req.params.productAccountId ?? req.header('x-whatchatai-product-account-id') ?? '');
    if (!accountId) {
      res.status(403).json({ error: 'PRODUCT_ACCOUNT_REQUIRED', product: productKey });
      return;
    }

    try {
      const access = await getProductAccountAccess(auth.userId, accountId);
      if (access.account.productKey !== productKey) {
        res.status(403).json({ error: 'PRODUCT_ACCESS_DENIED' });
        return;
      }
      if (!access.operationalAccess) {
        res.status(402).json({ error: 'PRODUCT_ACCESS_RESTRICTED', product: productKey, accountStatus: access.account.status });
        return;
      }
      if (entitlementKey && !access.entitlements.some((entitlement) => entitlement.key === entitlementKey && entitlement.enabled)) {
        res.status(403).json({ error: 'ENTITLEMENT_REQUIRED', entitlement: entitlementKey });
        return;
      }
      res.locals.productAccount = access;
      next();
    } catch (error) {
      if (error instanceof Error && error.message === 'Product account not found.') {
        res.status(404).json({ error: 'PRODUCT_ACCOUNT_NOT_FOUND' });
        return;
      }
      throw error;
    }
  };
}
