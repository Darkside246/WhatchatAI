/**
 * Google reCAPTCHA v3 (invisible, score-based - no puzzle for a real
 * person to solve) verification for public, unauthenticated endpoints
 * reachable from the open internet, starting with trial signup. Optional
 * by design, matching this codebase's own "genuinely not configured,
 * never fabricated" convention (Resend/Goose/Gmail OAuth all work the
 * same way): skipped entirely when RECAPTCHA_SECRET_KEY is unset, so
 * local dev and any environment that hasn't set this up yet never breaks.
 */

const SITEVERIFY_ENDPOINT = 'https://www.google.com/recaptcha/api/siteverify';

/** Google's own documented default threshold (0 = certainly a bot, 1 = certainly a real interaction) - a stated, tunable assumption, not a magic number. */
const MIN_SCORE = 0.5;

export function isRecaptchaConfigured(): boolean {
  return Boolean(process.env['RECAPTCHA_SECRET_KEY']);
}

export type RecaptchaResult = { ok: true } | { ok: false; reason: string };

interface SiteverifyResponse {
  success?: boolean;
  score?: number;
  ['error-codes']?: string[];
}

export async function verifyRecaptcha(token: string | undefined, remoteIp: string | null): Promise<RecaptchaResult> {
  const secret = process.env['RECAPTCHA_SECRET_KEY'];
  if (!secret) return { ok: true }; // Not configured - never blocks in this state, matching every other optional integration in this app.
  if (!token) return { ok: false, reason: 'Missing verification token.' };

  try {
    const params = new URLSearchParams({ secret, response: token });
    if (remoteIp) params.set('remoteip', remoteIp);
    const response = await fetch(SITEVERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const body = (await response.json()) as SiteverifyResponse;
    if (!body.success) return { ok: false, reason: 'Verification failed.' };
    if (typeof body.score === 'number' && body.score < MIN_SCORE) return { ok: false, reason: 'Verification score too low.' };
    return { ok: true };
  } catch (error) {
    console.error('[recaptchaService] Verification request failed:', error instanceof Error ? error.message : error);
    // Fails OPEN on a genuine network error reaching Google's own API, never
    // on a bad/missing token - an outage on Google's side must never be the
    // reason a real signup gets blocked.
    return { ok: true };
  }
}
