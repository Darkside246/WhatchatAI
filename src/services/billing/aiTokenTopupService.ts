import { pool } from '../../db/pool.js';
import { SubscriptionRepository } from '../../repositories/subscriptionRepository.js';
import { PlanRepository } from '../../repositories/planRepository.js';
import { AiTokenTopupRepository } from '../../repositories/aiTokenTopupRepository.js';
import { generateCheckoutReference } from './paymentService.js';
import { resolveProvider } from './providers/registry.js';
import { notifyBusiness } from '../notificationService.js';
import { getAiTokenTopupCatalogOverride } from '../platform/platformConfigService.js';
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
 * Pack sizes are half of each tier's own monthly budget. Prices target a
 * 60% MARGIN on token cost, which is price = cost / (1 - 0.60) = cost x 2.5.
 *
 * Margin and markup are NOT the same number and the difference is large
 * enough to be worth stating here: "add 60% to what the provider charges"
 * is a 60% MARKUP (price = cost x 1.6) and yields only a 37.5% margin. The
 * multiplier for a 60% margin is 2.5, not 1.6.
 *
 * Each price is rounded UP to a clean ending, so every pack clears 60%
 * rather than landing just under it:
 *   starter  (500K/mo)  -> 250K pack -> $2.19  (cost $0.84,  61.5% margin)
 *   growth   (2M/mo)    -> 1M pack   -> $8.49  (cost $3.38,  60.3% margin)
 *   business (10M/mo)   -> 5M pack   -> $42.99 (cost $16.88, 60.8% margin)
 *
 * IMPORTANT - this margin is on TOKEN COST ONLY. It does not account for
 * payment processing, which is charged per transaction and therefore hits
 * the small packs hardest. At a typical 2.9% + $0.30, the REAL margins are
 * roughly 43% (starter), 54% (growth) and 56% (business) - so the starter
 * pack keeps well under half of what this comment's headline figure
 * suggests. Reaching 60% NET of processing would need about $3.08 / $9.91 /
 * $46.29 instead. Left at the token-cost figure deliberately: the real
 * processor rates for BiMPay/WiPay are not known here, and guessing them
 * into customer-facing prices would be worse than stating the limit.
 * Enterprise is unlimited - the budget gate never fires, so no pack is
 * ever offered. Revisit this catalog if the real prompt/output token
 * ratio (once actually measurable from ai_usage_events) turns out to
 * differ meaningfully from the 75/25 assumption above.
 */
export type AiTokenTopupCatalog = Record<string, { tokens: number; priceCents: number; currency: string }>;

export const TOPUP_CATALOG: AiTokenTopupCatalog = {
  starter: { tokens: 250_000, priceCents: 219, currency: 'USD' },
  growth: { tokens: 1_000_000, priceCents: 849, currency: 'USD' },
  business: { tokens: 5_000_000, priceCents: 4299, currency: 'USD' },
};

/** Developer Master Control page override (platform_settings key ai_token_topup_catalog), falling back to the hardcoded TOPUP_CATALOG above when nothing's been set - additive, never a regression for this already-shipped upsell flow. */
async function resolveCatalog(): Promise<AiTokenTopupCatalog> {
  return (await getAiTokenTopupCatalogOverride()) ?? TOPUP_CATALOG;
}

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
  const catalog = await resolveCatalog();
  const entry = catalog[plan.planKey];
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
