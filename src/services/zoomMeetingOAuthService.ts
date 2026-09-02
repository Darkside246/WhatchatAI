/**
 * Zoom Meeting OAuth service — Authorization Code flow for a Zoom
 * connection used to book real Zoom meetings (see scheduleZoomMeetingTool.ts).
 * No SDKs: all HTTP calls use the global fetch API, matching
 * googleMeetingOAuthService.ts's structure - but Zoom's actual OAuth
 * mechanics differ in two real ways, not just naming:
 *
 *   1. Zoom requires its own, fully separate OAuth app (no GMAIL_CLIENT_ID
 *      reuse trick - Google and Zoom are different platforms).
 *   2. Zoom's token endpoint requires HTTP Basic auth
 *      (Authorization: Basic base64(client_id:client_secret)) for both the
 *      code exchange AND the refresh call - Google instead takes
 *      client_id/client_secret as body fields. Getting this wrong produces
 *      a real 401 from Zoom, not a silent failure.
 *
 * Required env vars: ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET / APP_URL.
 */

import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { ZoomMeetingRepository } from '../repositories/zoomMeetingRepository.js';

const repo = new ZoomMeetingRepository(pool);

function appUrl(): string {
  return (process.env['APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri(): string {
  return `${appUrl()}/api/meeting-oauth/callback/zoom`;
}

function zoomConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env['ZOOM_CLIENT_ID'];
  const clientSecret = process.env['ZOOM_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function basicAuthHeader(cfg: { clientId: string; clientSecret: string }): string {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`;
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

export type InitiateResult =
  | { status: 'ok'; redirectUrl: string }
  | { status: 'not_configured'; reason: string };

export function initiateOAuth(businessId: string, userId: string): InitiateResult {
  const cfg = zoomConfig();
  if (!cfg) return { status: 'not_configured', reason: 'Zoom OAuth is not configured on this server (missing ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET).' };

  const state = encodeState(businessId, userId);
  // No `scope` param here, unlike Google's authorize URL - a Zoom OAuth
  // app's scopes are declared at app-registration time on the Zoom
  // Marketplace, not requested per-authorization.
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri(),
    state,
  });
  return { status: 'ok', redirectUrl: `https://zoom.us/oauth/authorize?${params.toString()}` };
}

// ── Exchange code for tokens ────────────────────────────────────────────────

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
};

type ZoomUserProfile = { id: string; email: string; displayName: string | undefined };

async function exchangeZoomCode(code: string): Promise<{ tokens: TokenResponse; profile: ZoomUserProfile }> {
  const cfg = zoomConfig()!;
  const resp = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: basicAuthHeader(cfg),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
    }),
  });
  if (!resp.ok) throw new Error(`Zoom token exchange failed: ${await resp.text()}`);
  const tokens = (await resp.json()) as TokenResponse;

  const profileResp = await fetch('https://api.zoom.us/v2/users/me', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = (await profileResp.json()) as { id?: string; email?: string; first_name?: string; last_name?: string };
  const displayName = [profile.first_name, profile.last_name].filter(Boolean).join(' ').trim() || undefined;
  return { tokens, profile: { id: profile.id ?? '', email: profile.email ?? '', displayName } };
}

export type CallbackResult =
  | { status: 'connected'; zoomEmail: string }
  | { status: 'error'; reason: string };

export async function handleOAuthCallback(code: string, state: string): Promise<CallbackResult> {
  const decoded = decodeState(state);
  if (!decoded) return { status: 'error', reason: 'Invalid state parameter.' };
  const { businessId, userId } = decoded;

  try {
    const { tokens, profile } = await exchangeZoomCode(code);
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

    await repo.upsertConnection({
      businessId,
      zoomEmail: profile.email,
      zoomUserId: profile.id,
      displayName: profile.displayName ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope ?? null,
      connectedByUserId: userId,
    });

    return { status: 'connected', zoomEmail: profile.email };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[zoomMeetingOAuthService] OAuth callback failed:', msg);
    return { status: 'error', reason: msg };
  }
}

// ── Token refresh ───────────────────────────────────────────────────────────

export async function refreshAccessToken(connectionId: string, businessId: string): Promise<string | null> {
  const stored = await repo.getTokens(connectionId, businessId);
  if (!stored?.refreshToken) return null;

  const cfg = zoomConfig();
  if (!cfg) return null;

  try {
    const resp = await fetch('https://zoom.us/oauth/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: basicAuthHeader(cfg),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: stored.refreshToken,
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

export { repo as zoomMeetingRepo };
