import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { PlanRepository } from '../src/repositories/planRepository.js';
import { SubscriptionRepository } from '../src/repositories/subscriptionRepository.js';
import { SubscriptionEventRepository } from '../src/repositories/subscriptionEventRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('Plans and subscriptions', () => {
  let businessId: string;
  let plans: PlanRepository;
  let subscriptions: SubscriptionRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    plans = new PlanRepository(pool);
    subscriptions = new SubscriptionRepository(pool);
  });

  it('reads the real seeded plans and their entitlements (not fabricated)', async () => {
    const starter = await plans.findByKey('starter');
    expect(starter).not.toBeNull();
    expect(starter?.priceMonthlyCents).toBe(2900);

    const entitlement = await plans.getEntitlement(starter!.id, 'max_ai_agents');
    expect(entitlement?.limitValue).toBe(2);
    expect(entitlement?.isEnabled).toBe(true);
  });

  it('bootstraps a real trialing subscription for a business with no billing system yet', async () => {
    const starter = await plans.findByKey('starter');
    const subscription = await subscriptions.ensureDefault(businessId, starter!.id);

    expect(subscription.status).toBe('TRIALING');
    expect(subscription.planId).toBe(starter!.id);
    expect(subscription.trialEndsAt).toBeTruthy();
  });

  it('is idempotent: calling ensureDefault twice does not create two subscriptions', async () => {
    const starter = await plans.findByKey('starter');
    const first = await subscriptions.ensureDefault(businessId, starter!.id);
    const second = await subscriptions.ensureDefault(businessId, starter!.id);

    expect(second.id).toBe(first.id);
    const { rows } = await pool.query('SELECT count(*)::int AS count FROM subscriptions WHERE business_id = $1', [
      businessId,
    ]);
    expect(rows[0].count).toBe(1);
  });

  it('enforces one live subscription per business at the database level', async () => {
    const starter = await plans.findByKey('starter');
    const growth = await plans.findByKey('growth');
    await subscriptions.ensureDefault(businessId, starter!.id);

    // Directly attempting to insert a second live subscription must violate the
    // partial unique index - this is a real DB constraint, not app-level trust.
    await expect(
      pool.query(
        `INSERT INTO subscriptions (business_id, plan_id, status) VALUES ($1, $2, 'ACTIVE')`,
        [businessId, growth!.id],
      ),
    ).rejects.toThrow();
  });

  it('records real subscription lifecycle events', async () => {
    const starter = await plans.findByKey('starter');
    const subscription = await subscriptions.ensureDefault(businessId, starter!.id);
    const events = new SubscriptionEventRepository(pool);

    await events.record(businessId, subscription.id, 'created', null, 'TRIALING');
    await subscriptions.updateStatus(subscription.id, 'ACTIVE');
    await events.record(businessId, subscription.id, 'status_changed', 'TRIALING', 'ACTIVE');

    const history = await events.listBySubscription(subscription.id);
    expect(history).toHaveLength(2);
    expect(history[0].eventType).toBe('status_changed');

    const updated = await subscriptions.findById(subscription.id);
    expect(updated?.status).toBe('ACTIVE');
  });

  it('PlanRepository.findById reads a real seeded plan by id, mirroring findByKey', async () => {
    const starter = await plans.findByKey('starter');
    const byId = await plans.findById(starter!.id);
    expect(byId?.planKey).toBe('starter');
    expect(byId?.priceMonthlyCents).toBe(starter!.priceMonthlyCents);
  });

  it('findLiveByBusiness never returns another business’s subscription - it can only ever look up by businessId, not by a caller-supplied subscription id', async () => {
    const starter = await plans.findByKey('starter');
    const ownSubscription = await subscriptions.ensureDefault(businessId, starter!.id);

    const otherBusinessId = await createTestBusiness('Other Business');
    const otherLookup = await subscriptions.findLiveByBusiness(otherBusinessId);
    expect(otherLookup).toBeNull();

    const ownLookup = await subscriptions.findLiveByBusiness(businessId);
    expect(ownLookup?.id).toBe(ownSubscription.id);
  });
});
