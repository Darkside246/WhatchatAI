/**
 * Google reCAPTCHA verification for the public, unauthenticated endpoints
 * reachable from the open internet - signup, login, password reset.
 *
 * Two products, one interface. Classic reCAPTCHA v3 verifies a token against
 * siteverify with a shared secret; reCAPTCHA Enterprise posts an "assessment"
 * to a Google Cloud project with an API key and gets back a richer verdict.
 * They are not the same API and a key for one does not work on the other, so
 * which one runs is decided by which one is actually configured rather than
 * by a flag somebody has to keep in step.
 *
 * Optional by design, matching this codebase's "genuinely not configured,
 * never fabricated" convention (Resend, Goose and Gmail OAuth all work the
 * same way): with neither configured, verification is skipped entirely and
 * local dev never breaks.
 */

const SITEVERIFY_ENDPOINT = 'https://www.google.com/recaptcha/api/siteverify';

/**
 * Google's own documented default (0 = certainly a bot, 1 = certainly a real
 * person). A stated, tunable assumption rather than a magic number -
 * RECAPTCHA_MIN_SCORE overrides it without a deploy.
 */
const DEFAULT_MIN_SCORE = 0.5;

function minScore(): number {
  const configured = Number(process.env['RECAPTCHA_MIN_SCORE']);
  return Number.isFinite(configured) && configured > 0 && configured <= 1 ? configured : DEFAULT_MIN_SCORE;
}

type Mode = 'enterprise' | 'classic' | 'off';

/**
 * Enterprise wins when both are present.
 *
 * A deployment that has moved to Enterprise usually still has the old
 * secret sitting in its .env, and silently preferring the stale one would
 * verify against a project nobody is watching any more.
 */
function mode(): Mode {
  if (process.env['RECAPTCHA_ENTERPRISE_API_KEY'] && process.env['RECAPTCHA_ENTERPRISE_PROJECT_ID'] && process.env['RECAPTCHA_SITE_KEY']) {
    return 'enterprise';
  }
  if (process.env['RECAPTCHA_SECRET_KEY']) return 'classic';
  return 'off';
}

export function isRecaptchaConfigured(): boolean {
  return mode() !== 'off';
}

/** Which product is actually verifying, for the developer console's own "is this really on" answer. */
export function recaptchaMode(): Mode {
  return mode();
}

export type RecaptchaResult = { ok: true; score: number | null } | { ok: false; reason: string; score: number | null };

interface SiteverifyResponse {
  success?: boolean;
  score?: number;
  action?: string;
  ['error-codes']?: string[];
}

interface AssessmentResponse {
  riskAnalysis?: { score?: number; reasons?: string[] };
  tokenProperties?: { valid?: boolean; action?: string; invalidReason?: string; hostname?: string };
  error?: { message?: string };
}

/**
 * Verifies one token.
 *
 * `expectedAction` is not optional decoration. A token is minted in the
 * browser for a named action, and without checking it here a token harvested
 * from a cheap page - a signup form, a public landing page - can be replayed
 * against an expensive one. Google returns the action it was minted for;
 * comparing it is the only thing that binds the token to the thing being
 * protected.
 */
export async function verifyRecaptcha(
  token: string | undefined,
  remoteIp: string | null,
  expectedAction: string,
): Promise<RecaptchaResult> {
  const active = mode();
  // Not configured - never blocks in this state, matching every other
  // optional integration in this app.
  if (active === 'off') return { ok: true, score: null };
  if (!token) return { ok: false, reason: 'Missing verification token.', score: null };

  try {
    return active === 'enterprise'
      ? await assessEnterprise(token, expectedAction)
      : await assessClassic(token, remoteIp, expectedAction);
  } catch (error) {
    console.error('[recaptchaService] Verification request failed:', error instanceof Error ? error.message : error);
    // Fails OPEN on a genuine network error reaching Google, never on a bad
    // or missing token. An outage on Google's side must not be the reason a
    // real person cannot sign up or get into their own account.
    return { ok: true, score: null };
  }
}

async function assessClassic(token: string, remoteIp: string | null, expectedAction: string): Promise<RecaptchaResult> {
  const params = new URLSearchParams({ secret: process.env['RECAPTCHA_SECRET_KEY']!, response: token });
  if (remoteIp) params.set('remoteip', remoteIp);

  const response = await fetch(SITEVERIFY_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  const body = (await response.json()) as SiteverifyResponse;
  const score = typeof body.score === 'number' ? body.score : null;

  if (!body.success) return { ok: false, reason: 'Verification failed.', score };
  if (body.action && body.action !== expectedAction) {
    return { ok: false, reason: 'Verification was for a different action.', score };
  }
  if (score !== null && score < minScore()) return { ok: false, reason: 'Verification score too low.', score };
  return { ok: true, score };
}

/**
 * reCAPTCHA Enterprise: create an assessment against the project.
 *
 * The API key goes in the query string because that is the only way this
 * endpoint accepts one; it is a server-side secret and never reaches the
 * browser, which only ever holds the (public by design) site key.
 */
async function assessEnterprise(token: string, expectedAction: string): Promise<RecaptchaResult> {
  const project = process.env['RECAPTCHA_ENTERPRISE_PROJECT_ID']!;
  const apiKey = process.env['RECAPTCHA_ENTERPRISE_API_KEY']!;
  const siteKey = process.env['RECAPTCHA_SITE_KEY']!;

  const response = await fetch(
    `https://recaptchaenterprise.googleapis.com/v1/projects/${encodeURIComponent(project)}/assessments?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: { token, expectedAction, siteKey } }),
    },
  );

  const body = (await response.json()) as AssessmentResponse;
  const score = typeof body.riskAnalysis?.score === 'number' ? body.riskAnalysis.score : null;

  // A 4xx here is a configuration problem - wrong project, wrong key,
  // Enterprise not enabled - and is emphatically NOT evidence the visitor is
  // a bot. Treated as an outage so a misconfiguration cannot lock every real
  // person out of signing up, and logged loudly so it gets fixed.
  if (!response.ok) {
    console.error('[recaptchaService] Enterprise assessment rejected:', response.status, body.error?.message ?? '');
    return { ok: true, score };
  }

  const properties = body.tokenProperties ?? {};
  if (properties.valid !== true) {
    // MALFORMED, EXPIRED, DUPE, MISSING, BROWSER_ERROR. Reported as one
    // reason rather than passed through, so the exact invalidReason does not
    // end up in a response body telling somebody how to adjust their attempt.
    return { ok: false, reason: 'Verification token was not valid.', score };
  }
  // The binding that makes a token mean anything: Google echoes the action it
  // was minted for, and a token minted elsewhere must not work here.
  if (properties.action && properties.action !== expectedAction) {
    return { ok: false, reason: 'Verification was for a different action.', score };
  }
  if (score !== null && score < minScore()) return { ok: false, reason: 'Verification score too low.', score };

  return { ok: true, score };
}
