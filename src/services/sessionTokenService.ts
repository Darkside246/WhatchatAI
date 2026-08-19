import { createHash, randomBytes } from 'node:crypto';

/** The raw bearer token that actually lives in the browser's HttpOnly cookie - never persisted anywhere. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('hex');
}

/** What's actually stored in the sessions table - a lookup can't work backward to the raw token. */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Best-effort, honest parse - never fabricates a browser/OS name it didn't actually match. */
export function parseUserAgent(userAgent: string | null | undefined): { browser: string; os: string } {
  if (!userAgent) return { browser: 'Unknown browser', os: 'Unknown device' };

  let browser = 'Unknown browser';
  if (/Edg\//.test(userAgent)) browser = 'Edge';
  else if (/OPR\//.test(userAgent)) browser = 'Opera';
  else if (/Chrome\//.test(userAgent) && !/Chromium/.test(userAgent)) browser = 'Chrome';
  else if (/CriOS\//.test(userAgent)) browser = 'Chrome (iOS)';
  else if (/Firefox\//.test(userAgent)) browser = 'Firefox';
  else if (/Safari\//.test(userAgent) && /Version\//.test(userAgent)) browser = 'Safari';

  let os = 'Unknown device';
  if (/Windows/.test(userAgent)) os = 'Windows';
  else if (/Mac OS X/.test(userAgent) && !/iPhone|iPad/.test(userAgent)) os = 'macOS';
  else if (/iPhone/.test(userAgent)) os = 'iPhone';
  else if (/iPad/.test(userAgent)) os = 'iPad';
  else if (/Android/.test(userAgent)) os = 'Android';
  else if (/Linux/.test(userAgent)) os = 'Linux';

  return { browser, os };
}
