import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { sweepExpiredTrials } from '../src/services/billing/subscriptionExpiryService.js';
import { PlanRepository } from '../src/repositories/planRepository.js';
import { SubscriptionRepository } from '../src/repositories/subscriptionRepository.js';
import { SubscriptionEventRepository } from '../src/repositories/subscriptionEventRepository.js';
import { NotificationRepository } from '../src/repositories/notificationRepository.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

/**
 * Section 72 (billing preservation / cost control): before this sweep
 * existed, trial_ends_at was set correctly at signup and even displayed
 * to the business, but nothing ever acted on it - a trial never actually
 * expired, no matter how long it sat past its own end date.
 */
describe('sweepExpiredTrials (real Postgres, real subscription_events + notifications)', () => {
  let businessId: string;
  let planId: string;
  let subscriptions: SubscriptionRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    const plans = new PlanRepository(pool);
    const starter = await plans.findByKey('starter');
    planId = starter!.id;
    subscriptions = new SubscriptionRepository(pool);
  });

  it('transitions a genuinely lapsed TRIALING subscription to EXPIRED', async () => {
    const subscription = await subscriptions.ensureDefault(businessId, planId, -1);

    await sweepExpiredTrials();

    const updated = await subscriptions.findById(subscription.id);
    expect(updated?.status).toBe('EXPIRED');
  });

  it('never touches a subscription still within its real trial window', async () => {
    const subscription = await subscriptions.ensureDefault(businessId, planId, 14);

    await sweepExpiredTrials();

    const updated = await subscriptions.findById(subscription.id);
    expect(updated?.status).toBe('TRIALING');
  });

  it('records a real TRIAL_EXPIRED subscription_events row', async () => {
    const subscription = await subscriptions.ensureDefault(businessId, planId, -1);

    await sweepExpiredTrials();

    const events = new SubscriptionEventRepository(pool);
    const history = await events.listBySubscription(subscription.id);
    expect(history[0]?.eventType).toBe('TRIAL_EXPIRED');
    expect(history[0]?.previousStatus).toBe('TRIALING');
    expect(history[0]?.newStatus).toBe('EXPIRED');
  });

  it('notifies every active business member that the trial ended', async () => {
    const userId = await createTestUser(businessId); // already creates a real, active OWNER membership
    await subscriptions.ensureDefault(businessId, planId, -1);

    await sweepExpiredTrials();

    const notifications = await new NotificationRepository(pool).listForUser(businessId, userId, 10);
    expect(notifications.some((n) => n.type === 'PAYMENT_ISSUE' && n.title === 'Your free trial has ended')).toBe(true);
  });

  it('never expires an already-converted ACTIVE subscription, even with a stale past trial_ends_at', async () => {
    const subscription = await subscriptions.ensureDefault(businessId, planId, -1);
    await subscriptions.updateStatus(subscription.id, 'ACTIVE');

    await sweepExpiredTrials();

    const updated = await subscriptions.findById(subscription.id);
    expect(updated?.status).toBe('ACTIVE');
  });

  it('never touches a different business\'s expired trial by accident (tenant isolation)', async () => {
    const businessA = businessId;
    const businessB = await createTestBusiness('Business B');
    const subA = await subscriptions.ensureDefault(businessA, planId, -1);
    const subB = await subscriptions.ensureDefault(businessB, planId, 14);

    await sweepExpiredTrials();

    expect((await subscriptions.findById(subA.id))?.status).toBe('EXPIRED');
    expect((await subscriptions.findById(subB.id))?.status).toBe('TRIALING');
  });
});
