import { describe, expect, it, vi } from 'vitest';
import { requireActiveSubscription, requireDeveloper, requireDeveloperAdmin, requirePermission, type AuthContext } from '../src/server/authMiddleware.js';
import { createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

// Real gap this closes: invoicing, meeting-provider connections, and email-
// account connections previously had only requireAuth - any authenticated
// business could use them forever even with a fully cancelled/expired
// subscription. No plan tier/count limit is asserted here (that's real
// pricing data this test must never fabricate) - only the universal floor:
// a business with no live subscription at all is blocked.
function fakeAuth(overrides: Partial<AuthContext>): AuthContext {
  return {
    userId: 'user-1',
    businessId: 'business-1',
    role: 'OWNER' as AuthContext['role'],
    platformRole: 'CLIENT' as AuthContext['platformRole'],
    sessionId: 'session-1',
    user: {} as AuthContext['user'],
    ...overrides,
  };
}

function fakeRes() {
  const res: { locals: Record<string, unknown>; statusCode?: number; body?: unknown; status: (code: number) => typeof res; json: (body: unknown) => typeof res } = {
    locals: {},
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: unknown) {
      this.body = body;
      return this;
    },
  };
  return res;
}

describe('requireActiveSubscription (real Postgres)', () => {
  it('blocks a real business with no live subscription at all', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const res = fakeRes();
    res.locals.auth = fakeAuth({ businessId });
    const next = vi.fn();

    await requireActiveSubscription({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(402);
    expect(res.body).toEqual({ error: 'NO_ACTIVE_SUBSCRIPTION' });
  });

  it('allows a real business with a real live subscription through, regardless of tier', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    await createTestSubscription(businessId, 'starter');
    const res = fakeRes();
    res.locals.auth = fakeAuth({ businessId });
    const next = vi.fn();

    await requireActiveSubscription({} as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it('always lets a real platform developer through, even with no subscription', async () => {
    await resetDatabase();
    const res = fakeRes();
    res.locals.auth = fakeAuth({ businessId: 'no-such-business', platformRole: 'DEVELOPER' });
    const next = vi.fn();

    await requireActiveSubscription({} as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it('rejects an unauthenticated request', async () => {
    const res = fakeRes();
    const next = vi.fn();

    await requireActiveSubscription({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Real gap this closes: GET /api/workspace/integrations/health previously
 * carried no requirePermission guard at all - any authenticated role,
 * including VIEWER, could see it. Now gated on 'settings.manage', matching
 * SettingsRoute.tsx's own established canEdit convention (OWNER/ADMIN only).
 */
describe("requirePermission('settings.manage')", () => {
  const guard = requirePermission('settings.manage');

  it('blocks a VIEWER, who has no settings.manage permission', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ role: 'VIEWER' });
    const next = vi.fn();

    guard({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'PERMISSION_DENIED', permission: 'settings.manage', role: 'VIEWER' });
  });

  it('allows an OWNER through', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ role: 'OWNER' });
    const next = vi.fn();

    guard({} as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it('rejects an unauthenticated request', () => {
    const res = fakeRes();
    const next = vi.fn();

    guard({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Real gap this closes: GET /api/developer/integrations/status must only
 * ever be reachable by a genuine platform developer - a tenant business
 * owner/admin is not automatically one (directive: "Tenant admin !=
 * AURA platform developer").
 */
describe('requireDeveloper', () => {
  it('blocks a real business OWNER whose platformRole is the ordinary CLIENT default', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ role: 'OWNER', platformRole: 'CLIENT' });
    const next = vi.fn();

    requireDeveloper({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'DEVELOPER_ACCESS_REQUIRED' });
  });

  it('allows a real platform DEVELOPER through', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ platformRole: 'DEVELOPER' });
    const next = vi.fn();

    requireDeveloper({} as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it('rejects an unauthenticated request', () => {
    const res = fakeRes();
    const next = vi.fn();

    requireDeveloper({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});

/**
 * Migration 1002: the one real gate exclusive to the Admin developer
 * tier - managing other developer accounts and granting/revoking a
 * business's tier_unrestricted flag. Every other requireDeveloper route
 * stays open to a Standard developer unchanged (per the user's own
 * confirmed scope) - this middleware is the only new thing that narrows
 * access further, so it's the one piece that needs its own direct test.
 */
describe('requireDeveloperAdmin', () => {
  it('blocks a real business OWNER whose platformRole is the ordinary CLIENT default', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ role: 'OWNER', platformRole: 'CLIENT' });
    const next = vi.fn();

    requireDeveloperAdmin({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'DEVELOPER_ACCESS_REQUIRED' });
  });

  it('blocks a real Standard-tier developer - only Admin passes this gate', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ platformRole: 'DEVELOPER', user: { developerTier: 'STANDARD' } as AuthContext['user'] });
    const next = vi.fn();

    requireDeveloperAdmin({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'DEVELOPER_ADMIN_ACCESS_REQUIRED' });
  });

  it('blocks a developer whose tier is null (a pre-migration or malformed row) the same way as Standard - never fails open', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ platformRole: 'DEVELOPER', user: { developerTier: null } as AuthContext['user'] });
    const next = vi.fn();

    requireDeveloperAdmin({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ error: 'DEVELOPER_ADMIN_ACCESS_REQUIRED' });
  });

  it('allows a real Admin-tier developer through', () => {
    const res = fakeRes();
    res.locals.auth = fakeAuth({ platformRole: 'DEVELOPER', user: { developerTier: 'ADMIN' } as AuthContext['user'] });
    const next = vi.fn();

    requireDeveloperAdmin({} as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeUndefined();
  });

  it('rejects an unauthenticated request', () => {
    const res = fakeRes();
    const next = vi.fn();

    requireDeveloperAdmin({} as never, res as never, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
  });
});
