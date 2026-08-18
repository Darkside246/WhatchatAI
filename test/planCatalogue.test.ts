import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { WorkspaceService } from '../src/services/workspaceService.js';
import { createTestAccount, createTestBusiness, createTestSubscription, resetDatabase } from './helpers.js';

/**
 * The plan comparison shown to a customer must be the same data the
 * entitlement checks actually enforce - never a marketing table maintained
 * separately, which would be free to drift from reality.
 */
describe('plan catalogue (real plans table, not a marketing list)', () => {
  let businessId: string;
  let workspaceService: WorkspaceService;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    await createTestAccount(businessId);
    workspaceService = new WorkspaceService(pool);
  });

  it('returns the real seeded plans with their real entitlement limits', async () => {
    const catalogue = await workspaceService.getPlanCatalogue(businessId);

    expect(catalogue.plans.length).toBeGreaterThan(0);

    const starter = catalogue.plans.find((plan) => plan.planKey === 'starter');
    expect(starter).toBeDefined();
    expect(starter?.priceMonthlyCents).toBeGreaterThan(0);

    // Cross-check one limit against the plan_entitlements row itself, so this
    // fails if the catalogue ever starts reporting numbers of its own.
    // pg returns this column as a string; the repository is what converts it,
    // so the comparison normalises rather than asserting the raw driver type.
    const { rows } = await pool.query<{ limit_value: string | null }>(
      `SELECT e.limit_value
         FROM plan_entitlements e
         JOIN plans p ON p.id = e.plan_id
        WHERE p.plan_key = 'starter' AND e.entitlement_key = 'max_ai_agents'`,
    );
    const agentLimit = starter?.entitlements.find((entitlement) => entitlement.key === 'max_ai_agents');
    const rawLimit = rows[0]?.limit_value;
    expect(agentLimit?.limit).toBe(rawLimit === null || rawLimit === undefined ? null : Number(rawLimit));
  });

  it('marks exactly the subscribed plan as current', async () => {
    await createTestSubscription(businessId, 'growth');

    const catalogue = await workspaceService.getPlanCatalogue(businessId);
    const current = catalogue.plans.filter((plan) => plan.isCurrent);

    expect(current).toHaveLength(1);
    expect(current[0]?.planKey).toBe('growth');
  });

  it('marks no plan as current when the workspace has no subscription', async () => {
    const catalogue = await workspaceService.getPlanCatalogue(businessId);
    expect(catalogue.plans.some((plan) => plan.isCurrent)).toBe(false);
  });

  it('reports self-serve plan changes as unavailable, with a real reason - no fake upgrade button', async () => {
    const catalogue = await workspaceService.getPlanCatalogue(businessId);

    // There is no payment provider wired up. The UI reads this to decide
    // whether to offer a control it could actually honour.
    expect(catalogue.selfServeChangeAvailable).toBe(false);
    expect(catalogue.selfServeUnavailableReason).toBeTruthy();
  });
});
