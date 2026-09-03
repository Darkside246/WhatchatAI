import { pool } from '../../db/pool.js';
import { SubscriptionRepository } from '../../repositories/subscriptionRepository.js';
import { SubscriptionEventRepository } from '../../repositories/subscriptionEventRepository.js';
import { notifyBusiness } from '../notificationService.js';

const subscriptionRepository = new SubscriptionRepository(pool);
const subscriptionEventRepository = new SubscriptionEventRepository(pool);

/**
 * Section 72 (billing preservation / cost control): the real enforcement
 * side of trial_ends_at. Before this, a TRIALING subscription's expiry
 * timestamp was set correctly at signup and even shown to the business
 * (getBillingOverview's subscription.trialEndsAt), but nothing ever read
 * it back - a trial never actually expired. EntitlementService's checks
 * (canCreateAgent, canConnectWhatsAppAccount, canUseAiThisMonth, etc.)
 * already correctly deny NO_ACTIVE_SUBSCRIPTION; this is what makes a
 * lapsed trial's subscription actually stop being "live"
 * (subscriptionRepository.findLiveByBusiness only matches
 * LIVE_SUBSCRIPTION_STATUSES, which EXPIRED is deliberately not in) so
 * those checks start firing for real instead of never being reachable.
 *
 * Never touches ACTIVE/PAST_DUE/PAUSED/CANCELLED - only a subscription
 * still sitting in TRIALING past its own trial_ends_at with no real
 * payment ever having converted it.
 */
export async function sweepExpiredTrials(): Promise<void> {
  const expired = await subscriptionRepository.findExpiredTrials();
  for (const subscription of expired) {
    await subscriptionRepository.updateStatus(subscription.id, 'EXPIRED');
    await subscriptionEventRepository.record(subscription.businessId, subscription.id, 'TRIAL_EXPIRED', subscription.status, 'EXPIRED', {
      trialEndsAt: subscription.trialEndsAt,
    });
    await notifyBusiness({
      businessId: subscription.businessId,
      type: 'PAYMENT_ISSUE',
      severity: 'warning',
      title: 'Your free trial has ended',
      body: 'AI replies and other plan features are paused until a payment method is added.',
    }).catch((error) => {
      console.error('[subscriptionExpiryService] Failed to notify business of trial expiry:', error);
    });
  }
  if (expired.length > 0) {
    console.log(`[RealtimeEventsWorker] Expired ${expired.length} trial subscription(s) past their trial_ends_at`);
  }
}
