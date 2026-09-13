/**
 * Google reCAPTCHA (invisible - no puzzle, no user-visible widget).
 *
 * Two products with two different scripts and two different namespaces.
 * Classic v3 loads api.js and calls grecaptcha.execute; Enterprise loads
 * enterprise.js and calls grecaptcha.enterprise.execute. Loading the wrong
 * one for a given site key fails silently at execute() time, which is why
 * this reads a single explicit flag rather than guessing from the key.
 *
 * Optional by design: with no site key configured (local dev, or a
 * deployment that has not set this up), getRecaptchaToken() resolves to
 * undefined and the backend skips verification entirely - nothing breaks.
 *
 * The site key is public by design. It is embedded in the page and is
 * meant to be; the secret half (a classic secret, or an Enterprise API key)
 * only ever exists on the server.
 */

const SITE_KEY = import.meta.env['VITE_RECAPTCHA_SITE_KEY'] as string | undefined;
const ENTERPRISE = String(import.meta.env['VITE_RECAPTCHA_ENTERPRISE'] ?? '') === 'true';

let scriptLoadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const file = ENTERPRISE ? 'enterprise.js' : 'api.js';
    script.src = `https://www.google.com/recaptcha/${file}?render=${SITE_KEY}`;
    script.onload = () => resolve();
    script.onerror = () => {
      // Cleared so a later attempt can retry rather than being permanently
      // stuck on one rejected promise - an ad blocker or a dropped
      // connection on first load should not disable this for the session.
      scriptLoadPromise = null;
      reject(new Error('Failed to load reCAPTCHA script.'));
    };
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

interface GrecaptchaApi {
  ready: (callback: () => void) => void;
  execute: (siteKey: string, options: { action: string }) => Promise<string>;
}

declare global {
  interface Window {
    grecaptcha?: GrecaptchaApi & { enterprise?: GrecaptchaApi };
  }
}

/** Whichever namespace this deployment's script actually provides. */
function api(): GrecaptchaApi | undefined {
  return ENTERPRISE ? window.grecaptcha?.enterprise : window.grecaptcha;
}

/**
 * A real verification token for the given action, or undefined when
 * reCAPTCHA is not configured.
 *
 * Never throws. A load or execute failure degrades to "no token", and the
 * backend decides what that means - it treats a missing token as unverified
 * only when it actually has something to verify against.
 *
 * The action matters: the server checks that the token was minted for the
 * same action it is being spent on, so a token harvested from the signup
 * page cannot be replayed against login.
 */
export async function getRecaptchaToken(action: string): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  try {
    await loadScript();
    return await new Promise<string>((resolve, reject) => {
      const grecaptcha = api();
      if (!grecaptcha) {
        reject(new Error('reCAPTCHA script loaded but its API is missing.'));
        return;
      }
      grecaptcha.ready(() => {
        grecaptcha.execute(SITE_KEY, { action }).then(resolve).catch(reject);
      });
    });
  } catch (error) {
    console.warn('[recaptcha] Token generation failed, continuing without one:', error instanceof Error ? error.message : error);
    return undefined;
  }
}
