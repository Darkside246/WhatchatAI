/**
 * Google reCAPTCHA v3 (invisible - no puzzle, no user-visible widget).
 * Optional by design: when VITE_RECAPTCHA_SITE_KEY isn't set (local dev,
 * or any deployment that hasn't configured this yet), getRecaptchaToken()
 * resolves to undefined and the backend's own recaptchaService.ts skips
 * verification entirely - signup keeps working exactly as before.
 */

const SITE_KEY = import.meta.env['VITE_RECAPTCHA_SITE_KEY'] as string | undefined;

let scriptLoadPromise: Promise<void> | null = null;

function loadScript(): Promise<void> {
  if (scriptLoadPromise) return scriptLoadPromise;
  scriptLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://www.google.com/recaptcha/api.js?render=${SITE_KEY}`;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load reCAPTCHA script.'));
    document.head.appendChild(script);
  });
  return scriptLoadPromise;
}

declare global {
  interface Window {
    grecaptcha?: {
      ready: (callback: () => void) => void;
      execute: (siteKey: string, options: { action: string }) => Promise<string>;
    };
  }
}

/** Resolves to a real verification token for the given action, or undefined when reCAPTCHA isn't configured. Never throws - a load/execute failure degrades to "no token" (the backend treats a missing token as unverified only when it has a secret key to actually check against). */
export async function getRecaptchaToken(action: string): Promise<string | undefined> {
  if (!SITE_KEY) return undefined;
  try {
    await loadScript();
    return await new Promise<string>((resolve, reject) => {
      window.grecaptcha?.ready(() => {
        window.grecaptcha!.execute(SITE_KEY, { action }).then(resolve).catch(reject);
      });
    });
  } catch (error) {
    console.warn('[recaptcha] Token generation failed, continuing without one:', error instanceof Error ? error.message : error);
    return undefined;
  }
}
