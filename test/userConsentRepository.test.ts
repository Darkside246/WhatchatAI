import { describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { UserConsentRepository } from '../src/repositories/userConsentRepository.js';
import { resetDatabase } from './helpers.js';

/**
 * Real regression coverage for a live crash: create()/createConfirmation()
 * used to call .toISOString() on values the pool's global TIMESTAMPTZ type
 * parser (src/db/pool.ts) already converts to plain ISO strings, so every
 * real INSERT ... RETURNING threw "row.created_at.toISOString is not a
 * function" - blocking trial signup entirely, since recordConsent() is on
 * that path. No mocking: this exercises the real driver/type-parser
 * behavior a mocked Queryable would never reproduce.
 */
describe('UserConsentRepository (real Postgres) - the real timestamp-parsing crash', () => {
  it('creates a real consent record without throwing, and returns real ISO date strings', async () => {
    await resetDatabase();
    const repo = new UserConsentRepository(pool);

    const consent = await repo.create({
      fullName: 'Jane Doe',
      email: 'jane@example.com',
      phone: '+12461234567',
      termsVersion: '1.0',
      privacyVersion: '1.0',
      ipAddress: '127.0.0.1',
      userAgent: 'vitest',
      marketingOptIn: false,
    });

    expect(consent.id).toBeTruthy();
    expect(typeof consent.createdAt).toBe('string');
    expect(() => new Date(consent.createdAt)).not.toThrow();
    expect(new Date(consent.createdAt).toString()).not.toBe('Invalid Date');
    expect(consent.confirmedAt).toBeNull();
  });

  it('creates and looks up a real confirmation token without throwing', async () => {
    await resetDatabase();
    const repo = new UserConsentRepository(pool);
    const consent = await repo.create({
      fullName: 'John Smith',
      email: 'john@example.com',
      phone: '+12461234568',
      termsVersion: '1.0',
      privacyVersion: '1.0',
      ipAddress: null,
      userAgent: null,
      marketingOptIn: true,
    });

    const expiresAt = new Date(Date.now() + 60_000);
    const confirmation = await repo.createConfirmation({
      consentId: consent.id,
      token: 'real-test-token',
      method: 'email',
      expiresAt,
    });
    expect(typeof confirmation.createdAt).toBe('string');
    expect(typeof confirmation.expiresAt).toBe('string');
    expect(confirmation.usedAt).toBeNull();

    const found = await repo.findConfirmationByToken('real-test-token');
    expect(found?.id).toBe(confirmation.id);
    expect(typeof found?.expiresAt).toBe('string');

    await repo.markConfirmed(consent.id, 'email', confirmation.id);
    const { rows } = await pool.query('SELECT confirmed_at, confirmation_method FROM user_consents WHERE id = $1', [consent.id]);
    expect(rows[0]?.confirmed_at).not.toBeNull();
    expect(rows[0]?.confirmation_method).toBe('email');
  });
});
