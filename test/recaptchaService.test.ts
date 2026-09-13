import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isRecaptchaConfigured, recaptchaMode, verifyRecaptcha } from '../src/services/recaptchaService.js';

/**
 * Verifying a reCAPTCHA token.
 *
 * The assertion that matters most is the action binding. A token is minted
 * in the browser for a named action; without checking that the token really
 * was minted for the action it is being spent on, one harvested from a
 * public signup form can be replayed against login. Everything else here is
 * about failing in the right direction: a misconfiguration or an outage on
 * Google's side must never be the reason a real person cannot get into their
 * own account.
 */

const ENV_KEYS = [
  'RECAPTCHA_SECRET_KEY',
  'RECAPTCHA_ENTERPRISE_API_KEY',
  'RECAPTCHA_ENTERPRISE_PROJECT_ID',
  'RECAPTCHA_SITE_KEY',
  'RECAPTCHA_MIN_SCORE',
] as const;

const saved: Record<string, string | undefined> = {};

function enterprise(): void {
  process.env['RECAPTCHA_ENTERPRISE_API_KEY'] = 'test-api-key';
  process.env['RECAPTCHA_ENTERPRISE_PROJECT_ID'] = 'gen-lang-client-test';
  process.env['RECAPTCHA_SITE_KEY'] = 'test-site-key';
}

function classic(): void {
  process.env['RECAPTCHA_SECRET_KEY'] = 'test-secret';
}

/** One canned HTTP reply, so nothing in this file ever reaches Google. */
function respond(body: unknown, ok = true, status = 200) {
  return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok,
    status,
    json: async () => body,
  } as unknown as Response);
}

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe('when reCAPTCHA is not configured', () => {
  it('never blocks and never calls out', async () => {
    const fetchSpy = respond({});

    expect(isRecaptchaConfigured()).toBe(false);
    expect(recaptchaMode()).toBe('off');
    expect(await verifyRecaptcha(undefined, null, 'login')).toEqual({ ok: true, score: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('choosing a product', () => {
  it('uses Enterprise when it is configured', () => {
    enterprise();
    expect(recaptchaMode()).toBe('enterprise');
  });

  it('prefers Enterprise over a classic secret left behind from before', () => {
    // A deployment that has moved to Enterprise usually still has the old
    // secret in its .env. Verifying against the project nobody watches any
    // more would look like it was working.
    enterprise();
    classic();
    expect(recaptchaMode()).toBe('enterprise');
  });

  it('falls back to classic when only a secret is set', () => {
    classic();
    expect(recaptchaMode()).toBe('classic');
  });

  it('does not count a half-configured Enterprise setup as configured', () => {
    process.env['RECAPTCHA_ENTERPRISE_API_KEY'] = 'test-api-key';
    expect(recaptchaMode()).toBe('off');
  });
});

describe('Enterprise assessments', () => {
  beforeEach(enterprise);

  it('accepts a valid token with a good score', async () => {
    respond({ tokenProperties: { valid: true, action: 'login' }, riskAnalysis: { score: 0.9 } });

    expect(await verifyRecaptcha('tok', null, 'login')).toEqual({ ok: true, score: 0.9 });
  });

  it('posts the token, the expected action and the site key to the project', async () => {
    const fetchSpy = respond({ tokenProperties: { valid: true, action: 'login' }, riskAnalysis: { score: 0.9 } });
    await verifyRecaptcha('tok', null, 'login');

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/projects/gen-lang-client-test/assessments');
    expect(url).toContain('key=test-api-key');
    expect(JSON.parse(String(init.body))).toEqual({
      event: { token: 'tok', expectedAction: 'login', siteKey: 'test-site-key' },
    });
  });

  it('refuses a token minted for a different action', async () => {
    // The replay this exists to stop: a token harvested from the public
    // signup form, spent against login.
    respond({ tokenProperties: { valid: true, action: 'trial_register' }, riskAnalysis: { score: 0.9 } });

    const result = await verifyRecaptcha('tok', null, 'login');
    expect(result.ok).toBe(false);
  });

  it('refuses an invalid token whatever its score says', async () => {
    respond({ tokenProperties: { valid: false, invalidReason: 'EXPIRED' }, riskAnalysis: { score: 0.9 } });

    expect((await verifyRecaptcha('tok', null, 'login')).ok).toBe(false);
  });

  it('does not leak why the token was invalid', async () => {
    // Telling a caller "EXPIRED" versus "DUPE" tells them how to adjust.
    respond({ tokenProperties: { valid: false, invalidReason: 'DUPE' }, riskAnalysis: { score: 0.9 } });

    const result = await verifyRecaptcha('tok', null, 'login');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).not.toContain('DUPE');
  });

  it('refuses a score below the threshold', async () => {
    respond({ tokenProperties: { valid: true, action: 'login' }, riskAnalysis: { score: 0.1 } });

    expect((await verifyRecaptcha('tok', null, 'login')).ok).toBe(false);
  });

  it('honours a configured threshold', async () => {
    process.env['RECAPTCHA_MIN_SCORE'] = '0.2';
    respond({ tokenProperties: { valid: true, action: 'login' }, riskAnalysis: { score: 0.3 } });

    expect((await verifyRecaptcha('tok', null, 'login')).ok).toBe(true);
  });

  it('treats a rejected request as an outage, not as a bot', async () => {
    // Wrong project, wrong key, Enterprise not enabled on the account. None
    // of that is evidence about the visitor, and blocking on it would lock
    // every real person out of signing up until somebody noticed.
    respond({ error: { message: 'API key not valid' } }, false, 403);

    expect((await verifyRecaptcha('tok', null, 'login')).ok).toBe(true);
  });

  it('fails open when Google cannot be reached at all', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));

    expect((await verifyRecaptcha('tok', null, 'login')).ok).toBe(true);
  });

  it('still refuses a missing token while configured', async () => {
    // The one case that must NOT fail open: no token at all, with
    // verification switched on, is the shape every scripted request has.
    const fetchSpy = respond({});

    expect((await verifyRecaptcha(undefined, null, 'login')).ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('classic v3', () => {
  beforeEach(classic);

  it('accepts a successful verification', async () => {
    respond({ success: true, score: 0.8, action: 'login' });

    expect(await verifyRecaptcha('tok', null, 'login')).toEqual({ ok: true, score: 0.8 });
  });

  it('refuses a token minted for a different action', async () => {
    respond({ success: true, score: 0.9, action: 'trial_register' });

    expect((await verifyRecaptcha('tok', null, 'login')).ok).toBe(false);
  });

  it('refuses an unsuccessful verification', async () => {
    respond({ success: false, 'error-codes': ['timeout-or-duplicate'] });

    expect((await verifyRecaptcha('tok', null, 'login')).ok).toBe(false);
  });

  it('passes the caller IP through when it has one', async () => {
    const fetchSpy = respond({ success: true, score: 0.9, action: 'login' });
    await verifyRecaptcha('tok', '203.0.113.7', 'login');

    expect(String((fetchSpy.mock.calls[0]![1] as RequestInit).body)).toContain('remoteip=203.0.113.7');
  });
});
