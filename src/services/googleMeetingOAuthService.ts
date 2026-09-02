/**
 * Google Meeting OAuth service — Authorization Code flow for a Calendar
 * connection used to book real Google Meet calls (see scheduleMeetingTool.ts).
 * No SDKs: all HTTP calls use the global fetch API, matching emailOAuthService.ts.
 *
 * Deliberately reuses GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET rather than
 * introducing new env vars: Google OAuth 2.0 clients are not scope-bound
 * at registration - the same client requests calendar.events in a
 * completely separate consent flow from Gmail's, and Google issues an
 * independently-scoped token for it. The only real prerequisite is
 * enabling the Calendar API on the same Google Cloud project. This is a
 * genuinely separate connection/table from email_oauth_accounts (a
 * business may want one grant without the other), just sharing the same
 * underlying OAuth app.
 *
 * Required env vars (shared with emailOAuthService.ts):
 *   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET
 *   APP_URL  (used to build the redirect_uri)
 */

import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { GoogleMeetingRepository } from '../repositories/googleMeetingRepository.js';

const repo = new GoogleMeetingRepository(pool);

function appUrl(): string {
  return (process.env['APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri(): string {
  // Must match the :provider value meetingOAuthRouter.ts's isMeetingProvider
  // guard accepts ('google_meet'), the same literal used everywhere else
  // (MeetingProvider type, scheduled_meetings.provider column) - not a
  // shorthand 'google'.
  return `${appUrl()}/api/meeting-oauth/callback/google_meet`;
}

function googleConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env['GMAIL_CLIENT_ID'];
  const clientSecret = process.env['GMAIL_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

// ── CSRF state token ────────────────────────────────────────────────────────

export function encodeState(businessId: string, userId: string): string {
  const nonce = randomBytes(16).toString('base64url');
  return Buffer.from(JSON.stringify({ businessId, userId, nonce })).toString('base64url');
}

export function decodeState(state: string): { businessId: string; userId: string } | null {
  try {
    const raw = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const { businessId, userId } = raw as Record<string, unknown>;
    if (typeof businessId !== 'string' || typeof userId !== 'string') return null;
    return { businessId, userId };
  } catch {
    return null;
  }
}

// ── Initiate OAuth ──────────────────────────────────────────────────────────

// Minimal scope for creating/modifying events - deliberately not the
// broader `.../auth/calendar` (full account access, including settings
// and ACLs) or `calendar.events.readonly`.
const CALENDAR_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/calendar.events'].join(' ');

export type InitiateResult =
  | { status: 'ok'; redirectUrl: string }
  | { status: 'not_configured'; reason: string };

export function initiateOAuth(businessId: string, userId: string): InitiateResult {
  const cfg = googleConfig();
  if (!cfg) return { status: 'not_configured', reason: 'Google OAuth is not configured on this server (missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET).' };

  const state = encodeState(businessId, userId);
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: CALENDAR_SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return { status: 'ok', redirectUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
}

// ── Exchange code for tokens ────────────────────────────────────────────────

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
};

type UserProfile = { email: string; name: string | undefined };

async function exchangeGoogleCalendar(code: string): Promise<{ tokens: TokenResponse; profile: UserProfile }> {
  const cfg = googleConfig()!;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) throw new Error(`Google Calendar token exchange failed: ${await resp.text()}`);
  const tokens = (await resp.json()) as TokenResponse;

  const profileResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = (await profileResp.json()) as { email?: string; name?: string };
  return { tokens, profile: { email: profile.email ?? '', name: profile.name } };
}

export type CallbackResult =
  | { status: 'connected'; googleEmail: string }
  | { status: 'error'; reason: string };

export async function handleOAuthCallback(code: string, state: string): Promise<CallbackResult> {
  const decoded = decodeState(state);
  if (!decoded) return { status: 'error', reason: 'Invalid state parameter.' };
  const { businessId, userId } = decoded;

  try {
    const { tokens, profile } = await exchangeGoogleCalendar(code);
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

    await repo.upsertConnection({
      businessId,
      googleEmail: profile.email,
      displayName: profile.name ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope ?? null,
      connectedByUserId: userId,
    });

    return { status: 'connected', googleEmail: profile.email };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[googleMeetingOAuthService] OAuth callback failed:', msg);
    return { status: 'error', reason: msg };
  }
}

// ── Token refresh ───────────────────────────────────────────────────────────

export async function refreshAccessToken(connectionId: string, businessId: string): Promise<string | null> {
  const stored = await repo.getTokens(connectionId, businessId);
  if (!stored?.refreshToken) return null;

  const cfg = googleConfig();
  if (!cfg) return null;

  try {
    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        refresh_token: stored.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
    if (!resp.ok) return null;
    const tokens = (await resp.json()) as TokenResponse;
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

    await repo.updateTokens(connectionId, businessId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiresAt,
    });

    return tokens.access_token;
  } catch {
    return null;
  }
}

/** Returns a valid access token for the business's one connection, refreshing if needed, or null if not connected / refresh failed. */
export async function getValidAccessToken(businessId: string): Promise<string | null> {
  const connection = await repo.getConnectionByBusiness(businessId);
  if (!connection) return null;

  const isExpiringSoon = connection.tokenExpiresAt
    ? new Date(connection.tokenExpiresAt).getTime() - Date.now() < 5 * 60 * 1000
    : false;

  if (isExpiringSoon) {
    return refreshAccessToken(connection.id, businessId);
  }

  const stored = await repo.getTokens(connection.id, businessId);
  return stored?.accessToken ?? null;
}

// ── Connection management ───────────────────────────────────────────────────

export async function getConnection(businessId: string) {
  return repo.getConnectionByBusiness(businessId);
}

export async function disconnectConnection(businessId: string): Promise<boolean> {
  return repo.deleteConnection(businessId);
}

export { repo as googleMeetingRepo };
