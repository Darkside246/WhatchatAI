import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { EmailOAuthRepository } from '../src/repositories/emailOAuthRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * Real regression coverage for the same class of live crash fixed in
 * userConsentRepository.ts: mapAccount()/mapMessage() used to call
 * .toISOString() on values the pool's global TIMESTAMPTZ type parser
 * (src/db/pool.ts) already converts to plain ISO strings.
 */
describe('EmailOAuthRepository (real Postgres) - the real timestamp-parsing crash', () => {
  it('upserts a real account without throwing, and returns real ISO date strings', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);

    const account = await repo.upsertAccount({
      businessId,
      provider: 'gmail',
      emailAddress: 'ops@example.com',
      accessToken: 'real-access-token',
      refreshToken: 'real-refresh-token',
      tokenExpiresAt: new Date(Date.now() + 3600_000),
      scopes: 'https://mail.google.com/',
    });

    expect(account.id).toBeTruthy();
    expect(typeof account.createdAt).toBe('string');
    expect(typeof account.updatedAt).toBe('string');
    expect(typeof account.tokenExpiresAt).toBe('string');
    expect(() => new Date(account.createdAt)).not.toThrow();
    expect(new Date(account.createdAt).toString()).not.toBe('Invalid Date');
  });

  it('upserts a real account with no token expiry (null path) without throwing', async () => {
    await resetDatabase();
    const businessId = await createTestBusiness();
    const repo = new EmailOAuthRepository(pool);

    const account = await repo.upsertAccount({
      businessId,
      provider: 'outlook',
      emailAddress: 'ops2@example.com',
      accessToken: 'real-access-token-2',
    });

    expect(account.tokenExpiresAt).toBeNull();
    expect(account.lastSyncedAt).toBeNull();
    expect(typeof account.createdAt).toBe('string');
  });
});
