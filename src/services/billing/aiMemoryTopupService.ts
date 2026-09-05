import { pool } from '../../db/pool.js';
import { SubscriptionRepository } from '../../repositories/subscriptionRepository.js';
import { PlanRepository } from '../../repositories/planRepository.js';
import { AiMemoryTopupRepository } from '../../repositories/aiMemoryTopupRepository.js';
import { generateCheckoutReference } from './paymentService.js';
import { resolveProvider } from './providers/registry.js';
import { notifyBusiness } from '../notificationService.js';
import { getAiMemoryTopupCatalogOverride } from '../platform/platformConfigService.js';
import type { PaymentProvider } from '../../domain/billing/payment.js';
import type { VerifyEventResult } from './providers/types.js';

const subscriptionRepository = new SubscriptionRepository(pool);
const planRepository = new PlanRepository(pool);
const topupRepository = new AiMemoryTopupRepository(pool);

/**
 * A real, self-serve top-up for AI customer-memory capacity (migration
 * 982's max_customer_memory_profiles cap: 100/300/1,000 on
 * Starter/Growth/Business, unlimited on Enterprise). Unlike the AI token
 * top-up (aiTokenTopupService.ts), this pricing is NOT infra-cost-based -
 * a customer_memory row is a handful of small Postgres columns, real
 * storage cost is negligible regardless of plan tier. Pricing here
 * instead reflects the value of extra standing capacity, priced well
 * under the token packs since this is a smaller, one-time capacity bump
 * rather than a recurring monthly consumable.
 *
 * Pack sizes mirror the token top-up's own convention (half of the tier's
 * own cap):
 *   starter  (100 cap)   -> +50 profiles  -> $0.99
 *   growth   (300 cap)   -> +150 profiles -> $2.99
 *   business (1,000 cap) -> +500 profiles -> $6.99
 * Enterprise is unlimited - the cap never blocks anything, so no pack is
 * ever offered. Unlike AI tokens, a verified purchase here is added to the
 * business's effective limit permanently (see
 * aiMemoryTopupRepository.ts's getVerifiedProfilesForBusiness), not just
 * for the rest of the current calendar month - memory capacity is a
 * standing cap, not something that resets on the 1st.
 */
export type AiMemoryTopupCatalog = Record<string, { profiles: number; priceCents: number; currency: string }>;

export const MEMORY_TOPUP_CATALOG: AiMemoryTopupCatalog = {
  starter: { profiles: 50, priceCents: 99, currency: 'USD' },
  growth: { profiles: 150, priceCents: 299, currency: 'USD' },
  business: { profiles: 500, priceCents: 699, currency: 'USD' },
};

/** Developer Master Control page override (platform_settings key ai_memory_topup_catalog), falling back to the hardcoded MEMORY_TOPUP_CATALOG above when nothing's been set - additive, never a regression for this already-shipped upsell flow. */
async function resolveCatalog(): Promise<AiMemoryTopupCatalog> {
  return (await getAiMemoryTopupCatalogOverride()) ?? MEMORY_TOPUP_CATALOG;
}

export interface AiMemoryTopupOffer {
  planKey: string;
  profiles: number;
  priceCents: number;
  currency: string;
}

export class NoMemoryTopupOfferError extends Error {}

/** The real top-up offer for this business's current plan, or null if its plan has no catalog entry (enterprise/unlimited, or no live subscription at all). */
export async function getMemoryTopupOffer(businessId: string): Promise<AiMemoryTopupOffer | null> {
  const subscription = await subscriptionRepository.findLiveByBusiness(businessId);
  if (!subscription) return null;
  const plan = await planRepository.findById(subscription.planId);
  if (!plan) return null;
  const catalog = await resolveCatalog();
  const entry = catalog[plan.planKey];
  if (!entry) return null;
  return { planKey: plan.planKey, profiles: entry.profiles, priceCents: entry.priceCents, currency: entry.currency };
}

export async function createMemoryTopupCheckout(businessId: string, providerKind = 'bimpay'): Promise<{ purchase: Awaited<ReturnType<typeof topupRepository.create>>; instructions: Record<string, unknown> }> {
  const offer = await getMemoryTopupOffer(businessId);
  if (!offer) throw new NoMemoryTopupOfferError('This business has no available memory top-up offer (unlimited plan, or no active subscription).');

  const provider = resolveProvider(providerKind);
  if (!provider) throw new Error(`Unknown payment provider: ${providerKind}`);

  const reference = generateCheckoutReference('MEMTOPUP');
  const purchase = await topupRepository.create({
    businessId,
    provider: providerKind.toUpperCase() as PaymentProvider,
    checkoutReference: reference,
    profilesPurchased: offer.profiles,
    amountMinor: offer.priceCents,
    currency: offer.currency,
  });
  const instructions = await provider.buildCheckoutInstructions(reference, { amountMinor: offer.priceCents, currency: offer.currency });
  return { purchase, instructions };
}

export class MemoryTopupVerificationError extends Error {}

/** The webhook path: verifies the real payment amount/currency against what was actually charged at checkout time before crediting any capacity - same defensive shape as aiTokenTopupService.ts's verifyTopupPayment. */
export async function verifyMemoryTopupPayment(result: Extract<VerifyEventResult, { outcome: 'verified' }>): Promise<void> {
  const purchase = await topupRepository.findByCheckoutReference(result.checkoutReference);
  if (!purchase) throw new MemoryTopupVerificationError('Memory top-up checkout reference not found.');
  if (purchase.amountMinor !== result.amountMinor || purchase.currency !== result.currency.toUpperCase()) {
    throw new MemoryTopupVerificationError('Payment amount or currency does not match the memory top-up checkout.');
  }

  const { alreadyVerified } = await topupRepository.markVerified(result.checkoutReference, result.providerEventId);
  if (alreadyVerified) return;

  await notifyBusiness({
    businessId: purchase.businessId,
    type: 'AI_MEMORY_ADDED',
    severity: 'info',
    title: 'AI memory capacity added to your account',
    body: `${purchase.profilesPurchased.toLocaleString()} extra customer-memory slots have been added to your account, permanently.`,
  });
}
