import { describe, expect, it, vi } from 'vitest';
import { requireActiveSubscription, type AuthContext } from '../src/server/authMiddleware.js';
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
