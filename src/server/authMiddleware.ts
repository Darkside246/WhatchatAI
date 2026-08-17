import type { Request, Response, NextFunction } from 'express';
import { parseCookies, serializeCookie } from './cookies.js';
import { validateSession } from '../services/authService.js';
import { hasPermission, type BusinessRole, type Permission } from '../domain/auth/permissions.js';
import type { PublicUser } from '../repositories/userRepository.js';

export const SESSION_COOKIE_NAME = 'wc_session';

export interface AuthContext {
  userId: string;
  businessId: string;
  role: BusinessRole;
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

/**
 * The real authentication boundary. Populates res.locals.auth on success;
 * every /api/workspace/*, /api/whatsapp/*, /api/security/*, and /api/media/*
 * route sits behind this now - see server/index.ts's app.use() wiring.
 */
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
