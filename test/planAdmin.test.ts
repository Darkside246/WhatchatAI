import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PlanRepository } from '../src/repositories/planRepository.js';
import { AiUsageRepository } from '../src/repositories/aiUsageRepository.js';
import { createTestBusiness, createTestPlan, resetDatabase } from './helpers.js';

/**
 * Migration 025's own seed comment always promised these were "illustrative
 * starting values... the business can change" - these write paths
 * (planRepository.updatePlan/upsertEntitlement) are what finally makes that
 * true, backing the developer-only Plan Management UI.
 *
 * Every test here uses a throwaway plan (createTestPlan), never the real
 * seeded 'starter'/'growth'/etc. - resetDatabase() deliberately does not
 * truncate plans/plan_entitlements (they're reference data, not per-test
 * state, per helpers.ts's own NOTE), so mutating a real seed plan in place
 * would leak into every other test in the same process for the rest of the
 * run - exactly what happened the first time this file was written.
 */
describe('PlanRepository write paths (developer plan administration)', () => {
  let planRepository: PlanRepository;

  beforeEach(async () => {
    await resetDatabase();
    planRepository = new PlanRepository(pool);
  });

  it('updates only the fields provided, leaving the rest untouched', async () => {
    const planId = await createTestPlan();
    const before = await planRepository.findById(planId);
    if (!before) throw new Error('test plan not created');

    const updated = await planRepository.updatePlan(planId, { priceMonthlyCents: 3900 });
    expect(updated?.priceMonthlyCents).toBe(3900);
    expect(updated?.name).toBe(before.name);
    expect(updated?.priceYearlyCents).toBe(before.priceYearlyCents);
  });

  it('can retire a plan (isActive: false) and it drops out of listActive but stays in listAll', async () => {
    const planId = await createTestPlan();

    await planRepository.updatePlan(planId, { isActive: false });

    const active = await planRepository.listActive();
    expect(active.some((p) => p.id === planId)).toBe(false);

    const all = await planRepository.listAll();
    expect(all.some((p) => p.id === planId)).toBe(true);
  });

  it('returns the existing row unchanged when called with no fields to update', async () => {
    const planId = await createTestPlan();
    const before = await planRepository.findById(planId);

    const result = await planRepository.updatePlan(planId, {});
    expect(result).toEqual(before);
  });

  it('returns null for a plan id that does not exist', async () => {
    const result = await planRepository.updatePlan('00000000-0000-0000-0000-000000000000', { priceMonthlyCents: 100 });
    expect(result).toBeNull();
  });

  it('edits an existing entitlement in place', async () => {
    const planId = await createTestPlan();
    await planRepository.upsertEntitlement(planId, 'max_ai_agents', { limitValue: 2, isEnabled: true });

    const updated = await planRepository.upsertEntitlement(planId, 'max_ai_agents', { limitValue: 5, isEnabled: true });
    expect(updated.limitValue).toBe(5);
    expect(updated.isEnabled).toBe(true);

    const persisted = await planRepository.getEntitlement(planId, 'max_ai_agents');
    expect(persisted?.limitValue).toBe(5);
  });

  it('creates a brand new entitlement key for a plan that never had it', async () => {
    const planId = await createTestPlan();

    const before = await planRepository.getEntitlement(planId, 'a_future_entitlement_key');
    expect(before).toBeNull();

    const created = await planRepository.upsertEntitlement(planId, 'a_future_entitlement_key', { limitValue: 10, isEnabled: true });
    expect(created.entitlementKey).toBe('a_future_entitlement_key');
    expect(created.limitValue).toBe(10);
  });

  it('setting limitValue to null makes the entitlement genuinely unlimited, not zero', async () => {
    const planId = await createTestPlan();
    await planRepository.upsertEntitlement(planId, 'max_ai_agents', { limitValue: 2, isEnabled: true });

    const updated = await planRepository.upsertEntitlement(planId, 'max_ai_agents', { limitValue: null, isEnabled: true });
    expect(updated.limitValue).toBeNull();
  });

  it('an entitlement change on one plan never touches another plan\'s row for the same key', async () => {
    const planA = await createTestPlan();
    const planB = await createTestPlan();
    await planRepository.upsertEntitlement(planA, 'max_ai_agents', { limitValue: 2, isEnabled: true });
    await planRepository.upsertEntitlement(planB, 'max_ai_agents', { limitValue: 2, isEnabled: true });

    await planRepository.upsertEntitlement(planA, 'max_ai_agents', { limitValue: 99, isEnabled: true });

    const planBEntitlement = await planRepository.getEntitlement(planB, 'max_ai_agents');
    expect(planBEntitlement?.limitValue).toBe(2);
  });
});

describe('AiUsageRepository.getMonthlyTotalForBusiness (the number the AI cost-control gate checks)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('sums real usage events for the current calendar month', async () => {
    const businessId = await createTestBusiness();
    const usage = new AiUsageRepository(pool);
    await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 100, candidatesTokens: 50, totalTokens: 150 });
    await usage.record({ businessId, model: 'gemini-test', callKind: 'primary', promptTokens: 200, candidatesTokens: 100, totalTokens: 300 });

    const total = await usage.getMonthlyTotalForBusiness(businessId);
    expect(total).toBe(450);
  });

  it('returns 0 for a business with no recorded usage', async () => {
    const businessId = await createTestBusiness();
    const usage = new AiUsageRepository(pool);
    expect(await usage.getMonthlyTotalForBusiness(businessId)).toBe(0);
  });

  it('never counts another business\'s usage', async () => {
    const businessA = await createTestBusiness('Business A');
    const businessB = await createTestBusiness('Business B');
    const usage = new AiUsageRepository(pool);
    await usage.record({ businessId: businessA, model: 'gemini-test', callKind: 'primary', promptTokens: 1000, candidatesTokens: 1000, totalTokens: 2000 });

    expect(await usage.getMonthlyTotalForBusiness(businessB)).toBe(0);
  });
});
