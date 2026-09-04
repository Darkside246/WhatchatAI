/**
 * Email OAuth service — implements the Authorization Code flow for Gmail and Outlook.
 * No SDKs: all HTTP calls use the global fetch API for minimal dependencies.
 *
 * Required env vars:
 *   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET
 *   OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET
 *   APP_URL  (used to build the redirect_uri)
 */

import { randomBytes } from 'node:crypto';
import { pool } from '../db/pool.js';
import { EmailOAuthRepository, type OAuthProvider } from '../repositories/emailOAuthRepository.js';

const repo = new EmailOAuthRepository(pool);

// ── Config helpers ─────────────────────────────────────────────────────────

function appUrl(): string {
  return (process.env['APP_URL'] ?? 'http://localhost:3000').replace(/\/$/, '');
}

function redirectUri(provider: OAuthProvider): string {
  return `${appUrl()}/api/email-oauth/callback/${provider}`;
}

function gmailConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env['GMAIL_CLIENT_ID'];
  const clientSecret = process.env['GMAIL_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

function outlookConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env['OUTLOOK_CLIENT_ID'];
  const clientSecret = process.env['OUTLOOK_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Server-side credential presence only, per provider - never whether any business has actually connected. See listConnectedAccounts() for that. */
export function isConfigured(provider: OAuthProvider): boolean {
  return (provider === 'gmail' ? gmailConfig() : outlookConfig()) !== null;
}

// ── CSRF state token ────────────────────────────────────────────────────────

/** Encode businessId + provider into a CSRF state token. */
export function encodeState(businessId: string, provider: OAuthProvider): string {
  const nonce = randomBytes(16).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ businessId, provider, nonce })).toString('base64url');
  return payload;
}

export function decodeState(state: string): { businessId: string; provider: OAuthProvider } | null {
  try {
    const raw = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null) return null;
    const { businessId, provider } = raw as Record<string, unknown>;
    if (typeof businessId !== 'string' || (provider !== 'gmail' && provider !== 'outlook')) return null;
    return { businessId, provider };
  } catch {
    return null;
  }
}

// ── Initiate OAuth ──────────────────────────────────────────────────────────

const GMAIL_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/gmail.modify',
].join(' ');

const OUTLOOK_SCOPES = 'openid email profile Mail.ReadWrite offline_access';

export type InitiateResult =
  | { status: 'ok'; redirectUrl: string }
  | { status: 'not_configured'; reason: string };

export function initiateOAuth(businessId: string, provider: OAuthProvider): InitiateResult {
  const state = encodeState(businessId, provider);

  if (provider === 'gmail') {
    const cfg = gmailConfig();
    if (!cfg) return { status: 'not_configured', reason: 'Gmail OAuth is not configured on this server (missing GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET).' };
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: redirectUri('gmail'),
      response_type: 'code',
      scope: GMAIL_SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return { status: 'ok', redirectUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}` };
  }

  const cfg = outlookConfig();
  if (!cfg) return { status: 'not_configured', reason: 'Outlook OAuth is not configured on this server (missing OUTLOOK_CLIENT_ID / OUTLOOK_CLIENT_SECRET).' };
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: redirectUri('outlook'),
    response_type: 'code',
    scope: OUTLOOK_SCOPES,
    state,
  });
  return { status: 'ok', redirectUrl: `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}` };
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

async function exchangeGmail(code: string): Promise<{ tokens: TokenResponse; profile: UserProfile }> {
  const cfg = gmailConfig()!;
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri('gmail'),
      grant_type: 'authorization_code',
    }),
  });
  if (!resp.ok) throw new Error(`Gmail token exchange failed: ${await resp.text()}`);
  const tokens = (await resp.json()) as TokenResponse;

  const profileResp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = (await profileResp.json()) as { email?: string; name?: string };
  return { tokens, profile: { email: profile.email ?? '', name: profile.name } };
}

async function exchangeOutlook(code: string): Promise<{ tokens: TokenResponse; profile: UserProfile }> {
  const cfg = outlookConfig()!;
  const resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: redirectUri('outlook'),
      grant_type: 'authorization_code',
      scope: OUTLOOK_SCOPES,
    }),
  });
  if (!resp.ok) throw new Error(`Outlook token exchange failed: ${await resp.text()}`);
  const tokens = (await resp.json()) as TokenResponse;

  const profileResp = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,displayName', {
    headers: { authorization: `Bearer ${tokens.access_token}` },
  });
  const profile = (await profileResp.json()) as { mail?: string; displayName?: string };
  return { tokens, profile: { email: profile.mail ?? '', name: profile.displayName } };
}

export type CallbackResult =
  | { status: 'connected'; emailAddress: string; provider: OAuthProvider }
  | { status: 'error'; reason: string };

export async function handleOAuthCallback(
  provider: OAuthProvider,
  code: string,
  state: string,
): Promise<CallbackResult> {
  const decoded = decodeState(state);
  if (!decoded || decoded.provider !== provider) {
    return { status: 'error', reason: 'Invalid or mismatched state parameter.' };
  }
  const { businessId } = decoded;

  try {
    const { tokens, profile } = provider === 'gmail'
      ? await exchangeGmail(code)
      : await exchangeOutlook(code);

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000)
      : null;

    await repo.upsertAccount({
      businessId,
      provider,
      emailAddress: profile.email,
      displayName: profile.name ?? null,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiresAt,
      scopes: tokens.scope ?? null,
    });

    return { status: 'connected', emailAddress: profile.email, provider };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[emailOAuthService] OAuth callback failed for ${provider}:`, msg);
    return { status: 'error', reason: msg };
  }
}

// ── Token refresh ───────────────────────────────────────────────────────────

export async function refreshAccessToken(
  accountId: string,
  businessId: string,
  provider: OAuthProvider,
): Promise<string | null> {
  const stored = await repo.getTokens(accountId, businessId);
  if (!stored?.refreshToken) return null;

  try {
    let resp: Response;
    if (provider === 'gmail') {
      const cfg = gmailConfig();
      if (!cfg) return null;
      resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: stored.refreshToken,
          grant_type: 'refresh_token',
        }),
      });
    } else {
      const cfg = outlookConfig();
      if (!cfg) return null;
      resp = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: stored.refreshToken,
          grant_type: 'refresh_token',
          scope: provider === 'outlook' ? OUTLOOK_SCOPES : GMAIL_SCOPES,
        }),
      });
    }

    if (!resp.ok) return null;
    const tokens = (await resp.json()) as TokenResponse;
    const expiresAt = tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null;

    await repo.updateTokens(accountId, businessId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      tokenExpiresAt: expiresAt,
    });

    return tokens.access_token;
  } catch {
    return null;
  }
}

/** Returns a valid access token, refreshing if needed. */
export async function getValidAccessToken(
  accountId: string,
  businessId: string,
  provider: OAuthProvider,
): Promise<string | null> {
  const account = await repo.getById(accountId);
  if (!account) return null;

  const isExpiringSoon = account.tokenExpiresAt
    ? new Date(account.tokenExpiresAt).getTime() - Date.now() < 5 * 60 * 1000
    : false;

  if (isExpiringSoon) {
    return refreshAccessToken(accountId, businessId, provider);
  }

  const stored = await repo.getTokens(accountId, businessId);
  return stored?.accessToken ?? null;
}

// ── Account management ──────────────────────────────────────────────────────

export async function listConnectedAccounts(businessId: string) {
  return repo.listByBusiness(businessId);
}

export async function disconnectAccount(accountId: string, businessId: string): Promise<boolean> {
  return repo.deleteAccount(accountId, businessId);
}

export { repo as emailOAuthRepo };
