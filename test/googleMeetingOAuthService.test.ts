import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pool } from '../src/db/pool.js';
import { GoogleMeetingRepository } from '../src/repositories/googleMeetingRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';
import {
  decodeState,
  encodeState,
  getConnection,
  getValidAccessToken,
  handleOAuthCallback,
  initiateOAuth,
} from '../src/services/googleMeetingOAuthService.js';

/**
 * Mocks fetch directly rather than making live calls to Google, matching
 * the openclawSecurityWatcherService.test.ts convention (this sandbox's
 * egress policy blocks direct calls out, and a real OAuth exchange needs
 * a real user consent anyway).
 */
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', fetchMock);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('googleMeetingOAuthService', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    process.env['GMAIL_CLIENT_ID'] = 'test-client-id';
    process.env['GMAIL_CLIENT_SECRET'] = 'test-client-secret';
    process.env['APP_URL'] = 'https://app.example.com';
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('initiateOAuth', () => {
    it('requests the calendar.events scope with offline access and forced consent, carrying a decodable state', () => {
      const result = initiateOAuth('business-1', 'user-1');
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;

      const url = new URL(result.redirectUrl);
      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/calendar.events');
      expect(url.searchParams.get('access_type')).toBe('offline');
      expect(url.searchParams.get('prompt')).toBe('consent');
      expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/api/meeting-oauth/callback/google_meet');

      const state = url.searchParams.get('state');
      expect(state).toBeTruthy();
      expect(decodeState(state as string)).toEqual({ businessId: 'business-1', userId: 'user-1' });
    });

    it('fails honestly (not_configured) when the shared Gmail OAuth client credentials are missing', () => {
      delete process.env['GMAIL_CLIENT_ID'];
      delete process.env['GMAIL_CLIENT_SECRET'];

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
    it('rejects a tampered/mismatched state before ever calling Google', async () => {
      const result = await handleOAuthCallback('some-code', 'tampered-state');
      expect(result).toEqual({ status: 'error', reason: 'Invalid state parameter.' });
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('exchanges a real code, fetches the profile, and persists a real connection row', async () => {
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
            scope: 'https://www.googleapis.com/auth/calendar.events',
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ email: 'connected@example.com', name: 'Connected Person' }));

      const result = await handleOAuthCallback('real-code', state);
      expect(result).toEqual({ status: 'connected', googleEmail: 'connected@example.com' });

      const tokenExchangeCall = fetchMock.mock.calls[0];
      expect(tokenExchangeCall?.[0]).toBe('https://oauth2.googleapis.com/token');
      const sentBody = tokenExchangeCall?.[1]?.body as URLSearchParams;
      expect(sentBody.get('code')).toBe('real-code');
      expect(sentBody.get('grant_type')).toBe('authorization_code');
      expect(sentBody.get('redirect_uri')).toBe('https://app.example.com/api/meeting-oauth/callback/google_meet');

      const connection = await getConnection(businessId);
      expect(connection?.googleEmail).toBe('connected@example.com');
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
      const repo = new GoogleMeetingRepository(pool);
      await repo.upsertConnection({
        businessId,
        googleEmail: 'fresh@example.com',
        accessToken: 'still-valid-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(Date.now() + 3600_000),
      });

      const token = await getValidAccessToken(businessId);
      expect(token).toBe('still-valid-token');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes only when the token is within 5 minutes of expiry, and returns the freshly refreshed token', async () => {
      await resetDatabase();
      const businessId = await createTestBusiness();
      const repo = new GoogleMeetingRepository(pool);
      await repo.upsertConnection({
        businessId,
        googleEmail: 'expiring@example.com',
        accessToken: 'about-to-expire-token',
        refreshToken: 'refresh-token',
        tokenExpiresAt: new Date(Date.now() + 60_000),
      });

      fetchMock.mockResolvedValueOnce(jsonResponse({ access_token: 'refreshed-token', expires_in: 3600 }));

      const token = await getValidAccessToken(businessId);
      expect(token).toBe('refreshed-token');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const refreshCall = fetchMock.mock.calls[0];
      expect(refreshCall?.[0]).toBe('https://oauth2.googleapis.com/token');
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
      const repo = new GoogleMeetingRepository(pool);
      await repo.upsertConnection({
        businessId,
        googleEmail: 'revoked@example.com',
        accessToken: 'stale-token',
        refreshToken: 'revoked-refresh-token',
        tokenExpiresAt: new Date(Date.now() - 1000),
      });

      fetchMock.mockResolvedValueOnce(new Response('invalid_grant', { status: 400 }));

      expect(await getValidAccessToken(businessId)).toBeNull();
    });
  });
});
