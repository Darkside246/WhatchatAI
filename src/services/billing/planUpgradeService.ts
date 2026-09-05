import { pool } from '../../db/pool.js';
import { SubscriptionRepository } from '../../repositories/subscriptionRepository.js';
import { PlanRepository, type PlanRecord } from '../../repositories/planRepository.js';
import { PlanUpgradeRepository } from '../../repositories/planUpgradeRepository.js';
import { generateCheckoutReference } from './paymentService.js';
import { resolveProvider } from './providers/registry.js';
import { notifyBusiness } from '../notificationService.js';
import type { PaymentProvider } from '../../domain/billing/payment.js';
import type { VerifyEventResult } from './providers/types.js';

const subscriptionRepository = new SubscriptionRepository(pool);
const planRepository = new PlanRepository(pool);
const upgradeRepository = new PlanUpgradeRepository(pool);

/**
 * A real, self-serve plan-tier upgrade - "buy now" on any Plans tile takes
 * a business through this same checkout-then-verify flow the AI token/
 * memory top-ups already use (BiMPay bank-transfer memo, PayPal approval
 * link), since neither payment provider integrated here supports real
 * automated recurring billing or card-on-file charges.
 *
 * Proration policy (explicit product decision, not inferred): upgrading
 * within 5 days of the CURRENT billing period's start
 * (subscription.currentPeriodStart) credits the full price already paid
 * for the current plan against the new plan's price - "subtract the
 * money from the original plan." Upgrading after that 5-day window means
 * paying the new plan's full price, no credit for the unused remainder
 * of the old cycle. This is a one-time transition payment calculated and
 * shown at checkout time, never an automatic charge/refund against a
 * stored payment method (none is ever stored here).
 *
 * Refunds: the 48-hour no-refund-after-cancellation policy is displayed
 * to the business (PlanCheckoutRoute.tsx) as policy text only - a real
 * refund, if one is ever owed inside that window, is a manual action a
 * developer takes outside this app, the same way every other payment
 * here is manually verified rather than processed through a true
 * payment-gateway API.
 */
const PRORATION_WINDOW_DAYS = 5;

export interface PlanUpgradeOffer {
  currentPlan: { id: string; planKey: string; name: string; priceMonthlyCents: number };
  targetPlan: { id: string; planKey: string; name: string; priceMonthlyCents: number };
  currency: string;
  wasProrated: boolean;
  fullAmountCents: number;
  amountDueCents: number;
  prorationWindowEndsAt: string | null;
}

export class NoUpgradeOfferError extends Error {}

function isWithinProrationWindow(currentPeriodStart: string | null, now: Date): boolean {
  if (!currentPeriodStart) return false;
  const elapsedMs = now.getTime() - new Date(currentPeriodStart).getTime();
  return elapsedMs <= PRORATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

/** The real price a business would actually pay to move to targetPlanKey right now - never a plan they're already on, never a plan below what they currently pay (this is an upgrade flow, not a downgrade one). */
export async function getUpgradeOffer(businessId: string, targetPlanKey: string, now = new Date()): Promise<PlanUpgradeOffer> {
  const subscription = await subscriptionRepository.findLiveByBusiness(businessId);
  if (!subscription) throw new NoUpgradeOfferError('This business has no active subscription to upgrade.');
  const [currentPlan, targetPlan] = await Promise.all([
    planRepository.findById(subscription.planId),
    planRepository.findByKey(targetPlanKey),
  ]);
  if (!currentPlan) throw new NoUpgradeOfferError('Current plan not found.');
  if (!targetPlan) throw new NoUpgradeOfferError('Target plan not found.');
  if (targetPlan.id === currentPlan.id) throw new NoUpgradeOfferError('Already on this plan.');
  if (targetPlan.priceMonthlyCents <= currentPlan.priceMonthlyCents) {
    throw new NoUpgradeOfferError('This checkout is for upgrades only - the selected plan is not a real upgrade from the current one.');
  }

  const wasProrated = isWithinProrationWindow(subscription.currentPeriodStart, now);
  const fullAmountCents = targetPlan.priceMonthlyCents;
  const amountDueCents = wasProrated ? Math.max(0, targetPlan.priceMonthlyCents - currentPlan.priceMonthlyCents) : fullAmountCents;
  const prorationWindowEndsAt = subscription.currentPeriodStart
    ? new Date(new Date(subscription.currentPeriodStart).getTime() + PRORATION_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString()
    : null;

  return {
    currentPlan: { id: currentPlan.id, planKey: currentPlan.planKey, name: currentPlan.name, priceMonthlyCents: currentPlan.priceMonthlyCents },
    targetPlan: { id: targetPlan.id, planKey: targetPlan.planKey, name: targetPlan.name, priceMonthlyCents: targetPlan.priceMonthlyCents },
    currency: targetPlan.currency,
    wasProrated,
    fullAmountCents,
    amountDueCents,
    prorationWindowEndsAt,
  };
}

export async function createUpgradeCheckout(businessId: string, targetPlanKey: string, providerKind = 'bimpay'): Promise<{ purchase: Awaited<ReturnType<typeof upgradeRepository.create>>; instructions: Record<string, unknown> }> {
  const offer = await getUpgradeOffer(businessId, targetPlanKey);

  const provider = resolveProvider(providerKind);
  if (!provider) throw new Error(`Unknown payment provider: ${providerKind}`);

  const reference = generateCheckoutReference('UPGRADE');
  const purchase = await upgradeRepository.create({
    businessId,
    fromPlanId: offer.currentPlan.id,
    toPlanId: offer.targetPlan.id,
    provider: providerKind.toUpperCase() as PaymentProvider,
    checkoutReference: reference,
    wasProrated: offer.wasProrated,
    fullAmountMinor: offer.fullAmountCents,
    amountMinor: offer.amountDueCents,
    currency: offer.currency,
  });
  const instructions = await provider.buildCheckoutInstructions(reference, { amountMinor: offer.amountDueCents, currency: offer.currency });
  return { purchase, instructions };
}

export class UpgradeVerificationError extends Error {}

/** The webhook path: verifies the real payment amount/currency against what was actually due at checkout time, then actually applies the plan change - same defensive shape as the AI token/memory top-up services. */
export async function verifyUpgradePayment(result: Extract<VerifyEventResult, { outcome: 'verified' }>): Promise<void> {
  const purchase = await upgradeRepository.findByCheckoutReference(result.checkoutReference);
  if (!purchase) throw new UpgradeVerificationError('Plan upgrade checkout reference not found.');
  if (purchase.amountMinor !== result.amountMinor || purchase.currency !== result.currency.toUpperCase()) {
    throw new UpgradeVerificationError('Payment amount or currency does not match the upgrade checkout.');
  }

  const { alreadyVerified } = await upgradeRepository.markVerified(result.checkoutReference, result.providerEventId);
  if (alreadyVerified) return;

  const subscription = await subscriptionRepository.findLiveByBusiness(purchase.businessId);
  if (!subscription) throw new UpgradeVerificationError('No active subscription to apply this upgrade to.');
  await subscriptionRepository.changePlan(subscription.id, purchase.toPlanId);

  const targetPlan: PlanRecord | null = await planRepository.findById(purchase.toPlanId);
  await notifyBusiness({
    businessId: purchase.businessId,
    type: 'PLAN_UPGRADED',
    severity: 'info',
    title: 'Your plan has been upgraded',
    body: `You're now on the ${targetPlan?.name ?? 'new'} plan.`,
  });
}
