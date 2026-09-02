import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { GoogleMeetingRepository } from '../src/repositories/googleMeetingRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Real-Postgres coverage for GoogleMeetingRepository (connection CRUD
 * only, since phase 2 - see the scheduled_meetings note at the bottom of
 * this file), following the same pattern as emailOAuthRepository.test.ts:
 * upsert/token round-trip and ISO-string timestamp handling (the pool's
 * global TIMESTAMPTZ parser already converts these - mapConnection must
 * never re-call .toISOString() on an already-string value).
 */
describe('GoogleMeetingRepository (real Postgres)', () => {
  it('upserts a real connection without throwing, returns real ISO date strings, and never exposes tokens', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new GoogleMeetingRepository(pool);

    const connection = await repo.upsertConnection({
      businessId,
      googleEmail: 'ops@example.com',
      displayName: 'Ops Team',
      accessToken: 'real-access-token',
      refreshToken: 'real-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: 'https://www.googleapis.com/auth/calendar.events',
    });

    expect(connection.id).toBeTruthy();
    expect(connection.googleEmail).toBe('ops@example.com');
    expect(typeof connection.createdAt).toBe('string');
    expect(typeof connection.updatedAt).toBe('string');
    expect(typeof connection.tokenExpiresAt).toBe('string');
    expect(() => new Date(connection.createdAt)).not.toThrow();
    expect(new Date(connection.createdAt).toString()).not.toBe('Invalid Date');
    // The connection record returned to callers (e.g. the Settings API)
    // must never carry the encrypted or decrypted tokens.
    expect(connection).not.toHaveProperty('accessToken');
    expect(connection).not.toHaveProperty('refreshToken');
    expect(connection).not.toHaveProperty('accessTokenEnc');
  });

  it('upserts a connection with no token expiry (null path) without throwing', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new GoogleMeetingRepository(pool);

    const connection = await repo.upsertConnection({
      businessId,
      googleEmail: 'no-expiry@example.com',
      accessToken: 'real-access-token',
    });

    expect(connection.tokenExpiresAt).toBeNull();
    expect(connection.displayName).toBeNull();
    expect(connection.scopes).toBeNull();
  });

  it('round-trips the real plaintext tokens through getTokens - encrypted at rest, decrypted only for the service layer', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new GoogleMeetingRepository(pool);

    const connection = await repo.upsertConnection({
      businessId,
      googleEmail: 'roundtrip@example.com',
      accessToken: 'plaintext-access-token',
      refreshToken: 'plaintext-refresh-token',
    });

    // The value actually stored in the column must not be the plaintext
    // (proves encryption is really happening, not a no-op passthrough).
    const raw = await pool.query<{ access_token_enc: string }>(
      'SELECT access_token_enc FROM google_meeting_connections WHERE id = $1',
      [connection.id],
    );
    expect(raw.rows[0]?.access_token_enc).not.toBe('plaintext-access-token');

    const tokens = await repo.getTokens(connection.id, businessId);
    expect(tokens?.accessToken).toBe('plaintext-access-token');
    expect(tokens?.refreshToken).toBe('plaintext-refresh-token');
  });

  it('a second upsert for the same business replaces the connection (one connection per business) and preserves the refresh token when the new call omits one', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new GoogleMeetingRepository(pool);

    const first = await repo.upsertConnection({
      businessId,
      googleEmail: 'first@example.com',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
    });

    // Google's access-token refresh response often omits refresh_token
    // (it is only issued on the first grant) - a second upsert without one
    // must not null out the previously stored refresh token.
    const second = await repo.upsertConnection({
      businessId,
      googleEmail: 'second@example.com',
      accessToken: 'access-2',
    });

    expect(second.id).toBe(first.id);
    expect(second.googleEmail).toBe('second@example.com');

    const tokens = await repo.getTokens(second.id, businessId);
    expect(tokens?.accessToken).toBe('access-2');
    expect(tokens?.refreshToken).toBe('refresh-1');

    const all = await pool.query('SELECT id FROM google_meeting_connections WHERE business_id = $1', [businessId]);
    expect(all.rows).toHaveLength(1);
  });

  it('getConnectionByBusiness returns null when nothing is connected, and deleteConnection reports whether a row actually existed', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new GoogleMeetingRepository(pool);

    expect(await repo.getConnectionByBusiness(businessId)).toBeNull();
    expect(await repo.deleteConnection(businessId)).toBe(false);

    await repo.upsertConnection({ businessId, googleEmail: 'to-delete@example.com', accessToken: 'access' });
    expect(await repo.deleteConnection(businessId)).toBe(true);
    expect(await repo.getConnectionByBusiness(businessId)).toBeNull();
  });

  // Real scheduled_meetings row creation/listing (createMeeting/listByChat)
  // moved to scheduledMeetingsRepository.test.ts as of phase 2 (Zoom) - that
  // table is now shared across providers, no longer owned by this repository.
});
