/**
 * Developer Master Control Page: a real, cross-tenant "who is actually
 * out there" view - before this, "Clients" and "Trials" on that page
 * were just link-out cards to a developer's OWN business's CRM/Billing
 * pages (workspaceService-scoped, single-tenant), which is nonsensical
 * for a platform operator who needs to see every account, including
 * their own. Phone numbers are the one identifier requested - encrypted
 * at rest (migration 937), decrypted here per-user using the same
 * per-tenant key convention every other encrypted field in this app
 * already uses (tenantId = the user's own resolved business).
 */

import { pool } from '../../db/pool.js';
import { UserRepository } from '../../repositories/userRepository.js';
import { BusinessMembershipRepository } from '../../repositories/businessMembershipRepository.js';
import { BusinessRepository } from '../../repositories/businessRepository.js';
import { SubscriptionRepository, type SubscriptionRecord } from '../../repositories/subscriptionRepository.js';
import { PlanRepository } from '../../repositories/planRepository.js';
import { getEncryptionService } from '../../security/encryption/index.js';

const userRepository = new UserRepository(pool);
const membershipRepository = new BusinessMembershipRepository(pool);
const businessRepository = new BusinessRepository(pool);
const subscriptionRepository = new SubscriptionRepository(pool);
const planRepository = new PlanRepository(pool);

export interface DeveloperAccountSummary {
  userId: string;
  /** Decrypted, E.164-ish as originally stored - null when no phone was ever set (a legacy or email-only signup). */
  phoneNumber: string | null;
  /** Digits only, used for the real numeric sort - never displayed. */
  phoneDigits: string;
  isDeveloper: boolean;
  signupDate: string;
  businessId: string | null;
  businessName: string | null;
  subscriptionId: string | null;
  subscriptionStatus: SubscriptionRecord['status'] | null;
  trialEndsAt: string | null;
  planKey: string | null;
  planName: string | null;
}

/**
 * Every real user, including the calling developer's own account -
 * "who is on trial including myself" was the explicit ask. Sorted by
 * phone number in real numeric order; a user with no phone on file
 * sorts last (there's no number to order them by), never dropped from
 * the list entirely.
 */
export async function listAllAccounts(): Promise<DeveloperAccountSummary[]> {
  const { rows } = await pool.query<{
    id: string;
    phone_number: string | null;
    platform_role: 'CLIENT' | 'DEVELOPER';
    created_at: string;
  }>(`SELECT id, phone_number, platform_role, created_at FROM users WHERE deleted_at IS NULL ORDER BY created_at`);

  const summaries = await Promise.all(
    rows.map(async (row): Promise<DeveloperAccountSummary> => {
      const membership = await membershipRepository.findFirstActiveForUser(row.id);
      const business = membership ? await businessRepository.findById(membership.businessId) : null;
      const subscription = business ? await subscriptionRepository.findLiveByBusiness(business.id) : null;
      const plan = subscription ? await planRepository.findById(subscription.planId) : null;

      let phoneNumber: string | null = null;
      if (row.phone_number && membership) {
        try {
          const envelope = getEncryptionService().tryParse(row.phone_number);
          phoneNumber = envelope ? await getEncryptionService().decryptField(membership.businessId, envelope) : row.phone_number;
        } catch (error) {
          // A phone encrypted under a business this user no longer belongs
          // to (membership changed since) fails to decrypt - shown as
          // "unavailable" rather than crashing this whole cross-tenant list.
          console.warn(`[developerAccountsService] Could not decrypt phone number for user ${row.id}:`, error instanceof Error ? error.message : error);
        }
      }

      return {
        userId: row.id,
        phoneNumber,
        phoneDigits: (phoneNumber ?? '').replace(/\D/g, ''),
        isDeveloper: row.platform_role === 'DEVELOPER',
        signupDate: row.created_at,
        businessId: business?.id ?? null,
        businessName: business?.name ?? null,
        subscriptionId: subscription?.id ?? null,
        subscriptionStatus: subscription?.status ?? null,
        trialEndsAt: subscription?.trialEndsAt ?? null,
        planKey: plan?.planKey ?? null,
        planName: plan?.name ?? null,
      };
    }),
  );

  // Real numeric order: digit-string compared by length first (so "9" - 1
  // digit - never sorts ahead of "10000000000" - 11 digits, which naive
  // string comparison would get wrong), then lexically. No phone on file
  // sorts last, always - never mixed in ahead of a real number.
  return summaries.sort((a, b) => {
    if (!a.phoneDigits && !b.phoneDigits) return 0;
    if (!a.phoneDigits) return 1;
    if (!b.phoneDigits) return -1;
    if (a.phoneDigits.length !== b.phoneDigits.length) return a.phoneDigits.length - b.phoneDigits.length;
    return a.phoneDigits < b.phoneDigits ? -1 : a.phoneDigits > b.phoneDigits ? 1 : 0;
  });
}

export class BusinessHasNoSubscriptionError extends Error {}

/**
 * The manual override this whole feature exists for: a real payment that
 * fell outside the automated verify-then-apply webhook flow (a missed
 * webhook, a provider that isn't wired, cash/an out-of-band transfer) -
 * changePlan() itself already existed (planUpgradeService.ts's own
 * verified-payment path), this is simply its first manual caller.
 */
export async function manuallyChangeBusinessPlan(businessId: string, planKey: string): Promise<{ subscription: SubscriptionRecord; planName: string }> {
  const plan = await planRepository.findByKey(planKey);
  if (!plan) throw new Error(`Unknown plan key: ${planKey}`);

  const subscription = await subscriptionRepository.findLiveByBusiness(businessId);
  if (!subscription) throw new BusinessHasNoSubscriptionError('This business has no active/trialing subscription to change.');

  await subscriptionRepository.changePlan(subscription.id, plan.id);
  const updated = await subscriptionRepository.findById(subscription.id);
  if (!updated) throw new Error('subscription vanished immediately after changePlan()');
  return { subscription: updated, planName: plan.name };
}
