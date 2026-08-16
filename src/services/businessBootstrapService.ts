import { pool } from '../db/pool.js';
import { BusinessRepository, type BusinessRecord } from '../repositories/businessRepository.js';
import { PlanRepository } from '../repositories/planRepository.js';
import { SubscriptionRepository } from '../repositories/subscriptionRepository.js';

const businessRepository = new BusinessRepository(pool);
const planRepository = new PlanRepository(pool);
const subscriptionRepository = new SubscriptionRepository(pool);

const DEFAULT_PLAN_KEY = 'starter';

/**
 * The single-tenant bootstrap this whole app runs on until real
 * signup/billing exists (see BusinessRepository.ensureDefault() and
 * SubscriptionRepository.ensureDefault()'s own doc comments - this just
 * wires the two together). Without a real subscription row, every
 * entitlement-gated action (creating an AI agent, connecting another
 * WhatsApp account) fails with an honest "no active subscription" - never
 * a fabricated bypass, but also not something a real local install should
 * have to hit manually. A genuinely new business is put on a real trialing
 * subscription to the Starter plan the moment it's ensured to exist.
 */
export async function ensureDefaultBusinessProvisioned(): Promise<BusinessRecord> {
  const business = await businessRepository.ensureDefault();

  const plan = await planRepository.findByKey(DEFAULT_PLAN_KEY);
  if (!plan) {
    console.error(`[BusinessBootstrap] Seed plan "${DEFAULT_PLAN_KEY}" not found - cannot provision a default subscription. Did migrations run?`);
    return business;
  }

  await subscriptionRepository.ensureDefault(business.id, plan.id);
  return business;
}
