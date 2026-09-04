import { pool } from '../../db/pool.js';
import { SubscriptionRepository } from '../../repositories/subscriptionRepository.js';
import { PlanRepository } from '../../repositories/planRepository.js';
import { AiTokenTopupRepository } from '../../repositories/aiTokenTopupRepository.js';
import { generateCheckoutReference } from './paymentService.js';
import { resolveProvider } from './providers/registry.js';
import { notifyBusiness } from '../notificationService.js';
import type { PaymentProvider } from '../../domain/billing/payment.js';
import type { VerifyEventResult } from './providers/types.js';

const subscriptionRepository = new SubscriptionRepository(pool);
const planRepository = new PlanRepository(pool);
const topupRepository = new AiTokenTopupRepository(pool);

/**
 * Section 34-40's real budget-override flow: a self-serve AI-token
 * top-up, priced against the real cost of the Gemini 3.5 Flash calls this
 * platform actually makes (providerAdapters.ts), not a guessed number.
 *
 * Real Gemini 3.5 Flash pricing (ai.google.dev, confirmed live): $1.50
 * per 1M input tokens, $9.00 per 1M output tokens - output costs 6x more
 * than input. A WhatsApp AI reply is typically short against a
 * comparatively large context (system instruction + conversation history
 * + tool schemas), so this uses a stated, conservative assumption of a
 * 75% input / 25% output token split by count - not measured from real
 * usage data, which doesn't exist yet. That gives a blended raw cost of:
 *   0.75 * $1.50 + 0.25 * $9.00 = $3.375 per 1,000,000 tokens.
 *
 * Pack sizes are half of each tier's own monthly budget; prices are set
 * to land in the 50-60% profit-margin range the business asked for
 * (margin = (price - cost) / price):
 *   starter  (500K/mo)  -> 250K pack -> $1.99  (~$7.96/M effective, 57.6% margin)
 *   growth   (2M/mo)    -> 1M pack   -> $7.99  (~$7.99/M effective, 57.8% margin)
 *   business (10M/mo)   -> 5M pack   -> $37.99 (~$7.60/M effective, 55.6% margin)
 * Enterprise is unlimited - the budget gate never fires, so no pack is
 * ever offered. Revisit this catalog if the real prompt/output token
 * ratio (once actually measurable from ai_usage_events) turns out to
 * differ meaningfully from the 75/25 assumption above.
 */
export const TOPUP_CATALOG: Record<string, { tokens: number; priceCents: number; currency: string }> = {
  starter: { tokens: 250_000, priceCents: 199, currency: 'USD' },
  growth: { tokens: 1_000_000, priceCents: 799, currency: 'USD' },
  business: { tokens: 5_000_000, priceCents: 3799, currency: 'USD' },
};

export interface AiTokenTopupOffer {
  planKey: string;
  tokens: number;
  priceCents: number;
  currency: string;
}

export class NoTopupOfferError extends Error {}

/** The real top-up offer for this business's current plan, or null if its plan has no catalog entry (enterprise/unlimited, or no live subscription at all). */
export async function getTopupOffer(businessId: string): Promise<AiTokenTopupOffer | null> {
  const subscription = await subscriptionRepository.findLiveByBusiness(businessId);
  if (!subscription) return null;
  const plan = await planRepository.findById(subscription.planId);
  if (!plan) return null;
  const entry = TOPUP_CATALOG[plan.planKey];
  if (!entry) return null;
  return { planKey: plan.planKey, tokens: entry.tokens, priceCents: entry.priceCents, currency: entry.currency };
}

export async function createTopupCheckout(businessId: string, providerKind = 'bimpay'): Promise<{ purchase: Awaited<ReturnType<typeof topupRepository.create>>; instructions: Record<string, unknown> }> {
  const offer = await getTopupOffer(businessId);
  if (!offer) throw new NoTopupOfferError('This business has no available token top-up offer (unlimited plan, or no active subscription).');

  const provider = resolveProvider(providerKind);
  if (!provider) throw new Error(`Unknown payment provider: ${providerKind}`);

  const reference = generateCheckoutReference('TOPUP');
  const purchase = await topupRepository.create({
    businessId,
    provider: providerKind.toUpperCase() as PaymentProvider,
    checkoutReference: reference,
    tokensPurchased: offer.tokens,
    amountMinor: offer.priceCents,
    currency: offer.currency,
  });
  const instructions = await provider.buildCheckoutInstructions(reference, { amountMinor: offer.priceCents, currency: offer.currency });
  return { purchase, instructions };
}

export class TopupVerificationError extends Error {}

/**
 * The webhook path: verifies the real payment amount/currency against
 * what was actually charged for at checkout time before crediting a
 * single token - same defensive shape as paymentService.ts's
 * activateVerifiedPayment. A real "tokens added" notification only fires
 * on a genuine, new verification (never on the idempotent-repeat path).
 */
export async function verifyTopupPayment(result: Extract<VerifyEventResult, { outcome: 'verified' }>): Promise<void> {
  const purchase = await topupRepository.findByCheckoutReference(result.checkoutReference);
  if (!purchase) throw new TopupVerificationError('Top-up checkout reference not found.');
  if (purchase.amountMinor !== result.amountMinor || purchase.currency !== result.currency.toUpperCase()) {
    throw new TopupVerificationError('Payment amount or currency does not match the top-up checkout.');
  }

  const { alreadyVerified } = await topupRepository.markVerified(result.checkoutReference, result.providerEventId);
  if (alreadyVerified) return;

  await notifyBusiness({
    businessId: purchase.businessId,
    type: 'AI_TOKENS_ADDED',
    severity: 'info',
    title: 'AI tokens added to your account',
    body: `${purchase.tokensPurchased.toLocaleString()} extra AI tokens have been added to your budget for the rest of this month.`,
  });
}
