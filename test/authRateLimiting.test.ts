import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const serverSource = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/server/index.ts'),
  'utf8',
);

/**
 * Every door you can try a credential on is rate limited.
 *
 * The global limiter is 300 requests a minute per IP - deliberately
 * generous, an abuse brake rather than a product limit. It is nowhere near
 * tight enough to stop credential stuffing or scripted signup abuse, which
 * is what authLimiter (10 per 15 minutes) exists for.
 *
 * A security review found the driver portal's token-for-session exchange
 * covered only by the global one. The token is 32+ characters and compared
 * as a hash, so it was an inconsistency rather than a live hole - but "not
 * worth attacking today" is a property of the current token, not of the
 * endpoint, and the limiter is also what writes the auth_rate_limited audit
 * row the oversight sweep reads. Without it, the driver door was the one
 * credential endpoint nothing would have noticed being hammered.
 */

/** Every path registered as `app.use('<path>', authLimiter)`, in source order. */
const limited = [...serverSource.matchAll(/app\.use\(\s*'([^']+)'\s*,\s*authLimiter\s*\)/g)].map((m) => m[1] as string);

describe('the endpoints where a credential can be tried', () => {
  it('are all behind the tight limiter, named one by one', () => {
    // Enumerated rather than pattern-matched: a new credential endpoint
    // should have to be added here deliberately, by somebody who thought
    // about it, not pass because its path happens to contain "auth".
    for (const route of [
      '/api/auth/register',
      '/api/auth/login',
      '/api/trials/register',
      '/api/auth/password/forgot',
      '/api/auth/password/reset',
      '/api/auth/email/verify',
      '/api/driver/session',
    ]) {
      expect(limited, `${route} is not behind authLimiter`).toContain(route);
    }
  });

  it('is reading real registrations rather than silently matching nothing', () => {
    expect(limited.length).toBeGreaterThanOrEqual(7);
  });

  it('applies the limiter far below the global one, or it would do nothing', () => {
    // 10 per 15 minutes against 300 per minute. If these two ever converge,
    // the tight limiter has stopped being tight and this stops protecting
    // anything.
    const tight = /const authLimiter = rateLimit\(\{[\s\S]*?limit:\s*(\d+)/.exec(serverSource);
    const global = /app\.use\(\s*'\/api',\s*rateLimit\(\{[\s\S]*?limit:\s*(\d+)/.exec(serverSource);
    expect(tight).not.toBeNull();
    expect(global).not.toBeNull();
    expect(Number(tight![1])).toBeLessThan(Number(global![1]) / 10);
  });

  it('records every trip, so somebody hammering a door is visible afterwards', () => {
    // The limiter is not only a brake - it is the only thing that writes
    // auth_rate_limited, which is what the oversight sweep counts and now
    // alerts on. A limiter that blocked silently would stop the attack and
    // hide it.
    const handler = /const authLimiter = rateLimit\(\{[\s\S]*?\n\}\);/.exec(serverSource)?.[0] ?? '';
    expect(handler).toContain("eventType: 'auth_rate_limited'");
    expect(handler).toContain('429');
  });
});

describe('where the limiters are registered', () => {
  it('comes before the routers they protect, because Express runs middleware in order', () => {
    // The driver portal is mounted by mountPlatformRoutes(). A limiter
    // declared inside driverPortalRouter, or anywhere after that call,
    // would sit behind its own routes and never run - the failure mode
    // here is a test and a line of code that both look correct while
    // protecting nothing.
    const driverLimiter = serverSource.indexOf("app.use('/api/driver/session', authLimiter)");
    const platformMount = serverSource.indexOf('mountPlatformRoutes(app)');
    expect(driverLimiter).toBeGreaterThan(-1);
    expect(platformMount).toBeGreaterThan(-1);
    expect(driverLimiter).toBeLessThan(platformMount);
  });

  it('holds for every limited path, not just the driver one', () => {
    const platformMount = serverSource.indexOf('mountPlatformRoutes(app)');
    for (const route of limited) {
      const at = serverSource.indexOf(`app.use('${route}', authLimiter)`);
      expect(at, `${route} is registered after the routers it protects`).toBeLessThan(platformMount);
    }
  });
});
