import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { ensureDefaultBusinessProvisioned } from '../src/services/businessBootstrapService.js';
import { EntitlementService } from '../src/services/entitlementService.js';
import { resetDatabase } from './helpers.js';

describe('ensureDefaultBusinessProvisioned (single-tenant bootstrap: business + real Starter subscription)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('gives a genuinely new business a real, immediately usable trialing subscription - not a fabricated bypass', async () => {
    const business = await ensureDefaultBusinessProvisioned();

    const entitlements = new EntitlementService(pool);
    const check = await entitlements.canCreateAgent(business.id);
    expect(check.allowed).toBe(true);

    const { rows } = await pool.query<{ status: string; plan_id: string }>(
      'SELECT status, plan_id FROM subscriptions WHERE business_id = $1',
      [business.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('TRIALING');
  });

  it('is idempotent - a second call never creates a second business or a second subscription', async () => {
    const first = await ensureDefaultBusinessProvisioned();
    const second = await ensureDefaultBusinessProvisioned();

    expect(second.id).toBe(first.id);

    const { rows: businesses } = await pool.query('SELECT count(*) AS count FROM businesses');
    expect(Number(businesses[0].count)).toBe(1);

    const { rows: subscriptions } = await pool.query('SELECT count(*) AS count FROM subscriptions WHERE business_id = $1', [
      first.id,
    ]);
    expect(Number(subscriptions[0].count)).toBe(1);
  });
});
