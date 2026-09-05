import { describe, expect, it, beforeEach } from 'vitest';
import { pool } from '../src/db/pool.js';
import { BusinessRepository } from '../src/repositories/businessRepository.js';
import { UserRepository } from '../src/repositories/userRepository.js';
import { TrialRepository } from '../src/repositories/trialRepository.js';
import { EntitlementService } from '../src/services/entitlementService.js';
import { sweepExpiredProductTrials } from '../src/services/productAccountService.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Migration 1002: businesses.tier_unrestricted + users.developer_tier.
 * These tests prove the two real behavior changes this session's
 * Developer Control Plane work depends on - the entitlement bypass and
 * the developer-tier promote/demote lifecycle - without touching any
 * HTTP route (that's routeAuthorization.test.ts's job, still open work).
 */
describe('Developer Control Plane: tiered developer roles + businesses.tier_unrestricted', () => {
  let businessId: string;
  const businessRepository = new BusinessRepository(pool);
  const userRepository = new UserRepository(pool);
  const entitlementService = new EntitlementService(pool);

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
  });

  it('a business with tier_unrestricted=false (the default) is unaffected - normal entitlement denial still applies with no subscription', async () => {
    const result = await entitlementService.canCreateAgent(businessId);
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('NO_ACTIVE_SUBSCRIPTION');
  });

  it('a business with tier_unrestricted=true bypasses every entitlement check, even with zero subscription/plan at all', async () => {
    await businessRepository.setTierUnrestricted(businessId, true);
    const agent = await entitlementService.canCreateAgent(businessId);
    const whatsapp = await entitlementService.canConnectWhatsAppAccount(businessId);
    const aiMonth = await entitlementService.canUseAiThisMonth(businessId);
    const generic = await entitlementService.checkEntitlement(businessId, 'anything');
    expect(agent).toEqual({ allowed: true, limit: null });
    expect(whatsapp).toEqual({ allowed: true, limit: null });
    expect(aiMonth).toEqual({ allowed: true, limit: null });
    expect(generic).toEqual({ allowed: true, limit: null });
  });

  it('isTierUnrestricted reads exactly the stored flag, defaulting to false for an unknown id', async () => {
    expect(await businessRepository.isTierUnrestricted(businessId)).toBe(false);
    await businessRepository.setTierUnrestricted(businessId, true);
    expect(await businessRepository.isTierUnrestricted(businessId)).toBe(true);
    expect(await businessRepository.isTierUnrestricted('00000000-0000-0000-0000-000000000000')).toBe(false);
  });

  it('promoteToDeveloper sets both platform_role and developer_tier; demoteToClient resets developer_tier to null', async () => {
    const userId = await createTestUser(businessId);
    const promoted = await userRepository.promoteToDeveloper(userId, 'STANDARD');
    expect(promoted?.platformRole).toBe('DEVELOPER');
    expect(promoted?.developerTier).toBe('STANDARD');

    const demoted = await userRepository.demoteToClient(userId);
    expect(demoted?.platformRole).toBe('CLIENT');
    expect(demoted?.developerTier).toBeNull();
  });

  it('setDeveloperTier changes tier without touching platform_role, and only ever applies to an existing developer', async () => {
    const userId = await createTestUser(businessId);
    // Not yet a developer - setDeveloperTier's own WHERE clause refuses to act.
    expect(await userRepository.setDeveloperTier(userId, 'ADMIN')).toBeNull();

    await userRepository.promoteToDeveloper(userId, 'STANDARD');
    const changed = await userRepository.setDeveloperTier(userId, 'ADMIN');
    expect(changed?.platformRole).toBe('DEVELOPER');
    expect(changed?.developerTier).toBe('ADMIN');
  });

  it('listDevelopers returns every real developer, any tier, and never a plain CLIENT', async () => {
    const clientId = await createTestUser(businessId);
    const devId = await createTestUser(businessId);
    await userRepository.promoteToDeveloper(devId, 'STANDARD');

    const developers = await userRepository.listDevelopers();
    const ids = developers.map((d) => d.id);
    expect(ids).toContain(devId);
    expect(ids).not.toContain(clientId);
  });

  it('sweepExpiredProductTrials transitions a real, stale product_trials row past its ends_at to EXPIRED and restricts its product account', async () => {
    const trials = new TrialRepository(pool);
    const { rows: identityRows } = await pool.query<{ id: string }>(
      `INSERT INTO trial_identities (email) VALUES ($1) RETURNING id`,
      [`stale-trial-${Date.now()}@example.com`],
    );
    const identityId = identityRows[0]!.id;
    const { rows: productRows } = await pool.query<{ id: string }>(`SELECT id FROM product_catalog WHERE is_active = true LIMIT 1`);
    const productId = productRows[0]!.id;
    const ownerUserId = await createTestUser(businessId);
    const { rows: accountRows } = await pool.query<{ id: string }>(
      `INSERT INTO product_accounts (business_id, product_id, owner_user_id, status, display_name) VALUES ($1, $2, $3, 'ACTIVE', 'Stale Trial Account') RETURNING id`,
      [businessId, productId, ownerUserId],
    );
    const accountId = accountRows[0]!.id;
    const { rows: trialRows } = await pool.query<{ id: string }>(
      `INSERT INTO product_trials (trial_identity_id, product_id, product_account_id, state, starts_at, ends_at)
       VALUES ($1, $2, $3, 'ACTIVE', now() - interval '3 days', now() - interval '1 day') RETURNING id`,
      [identityId, productId, accountId],
    );
    const trialId = trialRows[0]!.id;

    const { swept } = await sweepExpiredProductTrials();
    expect(swept).toBeGreaterThanOrEqual(1);

    const refreshed = await trials.findTrialById(trialId);
    expect(refreshed?.state).toBe('EXPIRED');
    const { rows: accountCheck } = await pool.query<{ status: string }>('SELECT status FROM product_accounts WHERE id = $1', [accountId]);
    expect(accountCheck[0]?.status).toBe('RESTRICTED');
  });

  it('sweepExpiredProductTrials never touches a trial that has not reached its own ends_at yet', async () => {
    const trials = new TrialRepository(pool);
    const { rows: identityRows } = await pool.query<{ id: string }>(
      `INSERT INTO trial_identities (email) VALUES ($1) RETURNING id`,
      [`future-trial-${Date.now()}@example.com`],
    );
    const identityId = identityRows[0]!.id;
    const { rows: productRows } = await pool.query<{ id: string }>(`SELECT id FROM product_catalog WHERE is_active = true LIMIT 1`);
    const productId = productRows[0]!.id;
    const ownerUserId = await createTestUser(businessId);
    const { rows: accountRows } = await pool.query<{ id: string }>(
      `INSERT INTO product_accounts (business_id, product_id, owner_user_id, status, display_name) VALUES ($1, $2, $3, 'ACTIVE', 'Live Trial Account') RETURNING id`,
      [businessId, productId, ownerUserId],
    );
    const { rows: trialRows } = await pool.query<{ id: string }>(
      `INSERT INTO product_trials (trial_identity_id, product_id, product_account_id, state, starts_at, ends_at)
       VALUES ($1, $2, $3, 'ACTIVE', now(), now() + interval '1 day') RETURNING id`,
      [identityId, productId, accountRows[0]!.id],
    );
    const trialId = trialRows[0]!.id;

    await sweepExpiredProductTrials();
    const untouched = await trials.findTrialById(trialId);
    expect(untouched?.state).toBe('ACTIVE');
  });
});
