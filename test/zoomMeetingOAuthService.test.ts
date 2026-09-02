import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ZoomMeetingRepository } from '../src/repositories/zoomMeetingRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';
import {
  decodeState,
  encodeState,
  getConnection,
  getValidAccessToken,
  handleOAuthCallback,
  initiateOAuth,
} from '../src/services/zoomMeetingOAuthService.js';

/**
 * Mocks fetch directly, matching googleMeetingOAuthService.test.ts's own
 * convention. Zoom's real OAuth mechanics differ from Google's in two ways
 * this file specifically proves, not just naming: no scope/access_type/
 * prompt params on the authorize URL (Zoom declares scopes at
 * app-registration time), and HTTP Basic auth on the token endpoint for
 * both exchange and refresh (not client_id/secret in the body).
 */
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function decodeBasicAuth(header: string | null): { clientId: string; clientSecret: string } | null {
  if (!header?.startsWith('Basic ')) return null;
  const [clientId, clientSecret] = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8').split(':');
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

describe('zoomMeetingOAuthService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env['ZOOM_CLIENT_ID'] = 'test-zoom-client-id';
    process.env['ZOOM_CLIENT_SECRET'] = 'test-zoom-client-secret';
    process.env['APP_URL'] = 'https://app.example.com';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initiateOAuth', () => {
    it('builds a real Zoom authorize URL with a decodable state and no scope/access_type/prompt params', () => {
      const result = initiateOAuth('business-1', 'user-1');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      const url = new URL(result.redirectUrl);
      expect(url.origin + url.pathname).toBe('https://zoom.us/oauth/authorize');
      expect(url.searchParams.get('client_id')).toBe('test-zoom-client-id');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/meeting-oauth/callback/zoom');
      // Unlike Google's authorize URL, Zoom declares scope at app
      // registration - it must not appear here.
      expect(url.searchParams.has('scope')).toBe(false);
      expect(url.searchParams.has('access_type')).toBe(false);
      expect(url.searchParams.has('prompt')).toBe(false);

      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(decodeState(state as string)).toEqual({ businessId: 'business-1', userId: 'user-1' });
    });

    it('fails honestly (not_configured) when ZOOM_CLIENT_ID/SECRET are missing', () => {
      delete process.env['ZOOM_CLIENT_ID'];
      delete process.env['ZOOM_CLIENT_SECRET'];

      const result = initiateOAuth('business-1', 'user-1');
      expect(result.status).toBe('not_configured');
    });
  });

  describe('encodeState / decodeState', () => {
    it('round-trips a real businessId and userId', () => {
      const state = encodeState('biz-abc', 'user-xyz');
      expect(decodeState(state)).toEqual({ businessId: 'biz-abc', userId: 'user-xyz' });
    });

    it('rejects garbage, non-base64, and structurally-wrong state instead of throwing', () => {
      expect(decodeState('not-valid-base64-json!!!')).toBeNull();
      expect(decodeState(Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url'))).toBeNull();
      expect(decodeState(Buffer.from(JSON.stringify({ businessId: 123, userId: 'x' })).toString('base64url'))).toBeNull();
    });
  });

  describe('handleOAuthCallback', () => {
    it('rejects a tampered/mismatched state before ever calling Zoom', async () => {
      const result = await handleOAuthCallback('some-code', 'tampered-state');
      expect(result).toEqual({ status: 'error', reason: 'Invalid state parameter.' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('exchanges a real code with HTTP Basic auth, fetches the profile, and persists a real connection row', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const userId = await createTestUser(businessId);
      const state = encodeState(businessId, userId);

      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            access_token: 'new-access-token',
            refresh_token: 'new-refresh-token',
            expires_in: 3600,
            scope: 'meeting:write',
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ id: 'zoom-user-1', email: 'connected@example.com', first_name: 'Connected', last_name: 'Person' }));

      const result = await handleOAuthCallback('real-code', state);
      expect(result).toEqual({ status: 'connected', zoomEmail: 'connected@example.com' });

      const tokenExchangeCall = fetchMock.mock.calls[0];
      expect(tokenExchangeCall?.[0]).toBe('https://zoom.us/oauth/token');
      const headers = tokenExchangeCall?.[1]?.headers as Record<string, string>;
      const auth = decodeBasicAuth(headers['authorization']);
      expect(auth).toEqual({ clientId: 'test-zoom-client-id', clientSecret: 'test-zoom-client-secret' });

      const sentBody = tokenExchangeCall?.[1]?.body as URLSearchParams;
      expect(sentBody.get('code')).toBe('real-code');
      expect(sentBody.get('grant_type')).toBe('authorization_code');
      expect(sentBody.get('redirect_uri')).toBe('https://app.example.com/api/meeting-oauth/callback/zoom');
      // Basic auth already carries the client credentials - Zoom's token
      // endpoint does not also expect them in the body.
      expect(sentBody.has('client_id')).toBe(false);
      expect(sentBody.has('client_secret')).toBe(false);

      const connection = await getConnection(businessId);
      expect(connection?.zoomEmail).toBe('connected@example.com');
      expect(connection?.zoomUserId).toBe('zoom-user-1');
      expect(connection?.displayName).toBe('Connected Person');
    });

    it('reports an honest error when the token exchange itself fails, and persists nothing', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const userId = await createTestUser(businessId);
      const state = encodeState(businessId, userId);

      fetchMock.mockResolvedValueOnce(new Response('invalid_grant', { status: 400 }));

      const result = await handleOAuthCallback('bad-code', state);
      expect(result.status).toBe('error');
      expect(await getConnection(businessId)).toBeNull();
    });
  });

  describe('getValidAccessToken', () => {
    it('returns null when the business has no connection at all', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      expect(await getValidAccessToken(businessId)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns the stored token directly, without refreshing, when it is not close to expiry', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const repo = new ZoomMeetingRepository(pool);
      await repo.upsertConnection({
        businessId,
        zoomEmail: 'fresh@example.com',
        zoomUserId: 'zoom-user-2',
        accessToken: 'still-valid-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(Date.now() + 3600_000),
      });

      const token = await getValidAccessToken(businessId);
      expect(token).toBe('still-valid-token');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes only when the token is within 5 minutes of expiry, using HTTP Basic auth, and returns the freshly refreshed token', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const repo = new ZoomMeetingRepository(pool);
      await repo.upsertConnection({
        businessId,
        zoomEmail: 'expiring@example.com',
        zoomUserId: 'zoom-user-3',
        accessToken: 'about-to-expire-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(Date.now() + 60_000),
      });

      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'refreshed-token', expires_in: 3600 }));

      const token = await getValidAccessToken(businessId);
      expect(token).toBe('refreshed-token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const refreshCall = fetchMock.mock.calls[0];
      expect(refreshCall?.[0]).toBe('https://zoom.us/oauth/token');
      const headers = refreshCall?.[1]?.headers as Record<string, string>;
      expect(decodeBasicAuth(headers['authorization'])).toEqual({ clientId: 'test-zoom-client-id', clientSecret: 'test-zoom-client-secret' });
      const sentBody = refreshCall?.[1]?.body as URLSearchParams;
      expect(sentBody.get('grant_type')).toBe('refresh_token');
      expect(sentBody.get('refresh_token')).toBe('refresh-token');

      const persisted = await getConnection(businessId);
      const stored = await repo.getTokens((persisted as { id: string }).id, businessId);
      expect(stored?.accessToken).toBe('refreshed-token');
    });

    it('returns null when the refresh call itself fails (e.g. a revoked grant)', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const repo = new ZoomMeetingRepository(pool);
      await repo.upsertConnection({
        businessId,
        zoomEmail: 'revoked@example.com',
        zoomUserId: 'zoom-user-4',
        accessToken: 'stale-token',
        refreshToken: 'revoked-refresh-token',
        tokenExpiresAt: new Date(Date.now() - 1000),
      });

      fetchMock.mockResolvedValueOnce(new Response('invalid_grant', { status: 400 }));

      expect(await getValidAccessToken(businessId)).toBeNull();
    });
  });
});
