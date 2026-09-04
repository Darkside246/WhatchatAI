import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PlatformSettingsRepository } from '../src/repositories/platformSettingsRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Backs the live developer toggles introduced for Section 73-74 (payment
 * provider enable/disable) and Section 41-42 Phase 1 (the autonomy kill
 * switch) - a small, generic platform-wide key/value store, genuinely
 * reused by both features rather than two bespoke bool columns.
 */
describe('PlatformSettingsRepository (real Postgres - migration 977)', () => {
  const repo = new PlatformSettingsRepository(pool);

  beforeEach(async () => {
    await resetDatabase();
  });

  it('returns null for a key that has never been set', async () => {
    expect(await repo.get('autonomy_kill_switch')).toBeNull();
  });

  it('sets a real value and reads it back, with the acting user recorded', async () => {
    const businessId = await createTestBusiness();
    const userId = await createTestUser(businessId);
    const record = await repo.set('autonomy_kill_switch', { enabled: true }, userId);
    expect(record.value).toEqual({ enabled: true });
    expect(record.updatedByUserId).toBe(userId);

    const fetched = await repo.get('autonomy_kill_switch');
    expect(fetched?.value).toEqual({ enabled: true });
  });

  it('is a real upsert - setting an existing key replaces its value rather than erroring', async () => {
    await repo.set('payment_provider:paypal', { enabled: true }, null);
    const updated = await repo.set('payment_provider:paypal', { enabled: false }, null);
    expect(updated.value).toEqual({ enabled: false });

    const all = await repo.listAll();
    expect(all).toHaveLength(1);
  });

  it('listAll returns every distinct key, independently settable', async () => {
    await repo.set('payment_provider:paypal', { enabled: true }, null);
    await repo.set('payment_provider:wipay', { enabled: false }, null);
    const all = await repo.listAll();
    expect(all.map((r) => r.key).sort()).toEqual(['payment_provider:paypal', 'payment_provider:wipay']);
  });
});
