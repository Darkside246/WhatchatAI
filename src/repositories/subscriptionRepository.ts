import type { Queryable } from './types.js';
import type { SubscriptionStatus } from '../domain/platform/types.js';
import { LIVE_SUBSCRIPTION_STATUSES } from '../domain/platform/types.js';

export interface SubscriptionRecord {
  id: string;
  businessId: string;
  planId: string;
  status: SubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelledAt: string | null;
  paymentProvider: string | null;
  paymentCustomerId: string | null;
  paymentSubscriptionId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface SubscriptionRow {
  id: string;
  business_id: string;
  plan_id: string;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  trial_ends_at: string | null;
  cancelled_at: string | null;
  payment_provider: string | null;
  payment_customer_id: string | null;
  payment_subscription_id: string | null;
  created_at: string;
  updated_at: string;
}

function toRecord(row: SubscriptionRow): SubscriptionRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    planId: row.plan_id,
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    trialEndsAt: row.trial_ends_at,
    cancelledAt: row.cancelled_at,
    paymentProvider: row.payment_provider,
    paymentCustomerId: row.payment_customer_id,
    paymentSubscriptionId: row.payment_subscription_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SubscriptionRepository {
  constructor(private readonly db: Queryable) {}

  async findLiveByBusiness(businessId: string): Promise<SubscriptionRecord | null> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `SELECT * FROM subscriptions WHERE business_id = $1 AND status = ANY($2::text[])`,
      [businessId, LIVE_SUBSCRIPTION_STATUSES],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Real product bootstrap for pre-Authentication/Billing operation: gives a
   * business a real trialing subscription to a real plan so entitlements can
   * be enforced. Not fabricated usage - it's the same "no signup flow yet"
   * limitation as BusinessRepository.ensureDefault().
   *
   * The check-then-insert this replaced raced under real concurrency: two
   * callers could both see "no live subscription yet" via findLiveByBusiness
   * before either INSERT committed, and the second then hit
   * subscriptions_one_live_per_business_idx as a thrown constraint
   * violation instead of a handled "someone else already provisioned this"
   * outcome. ON CONFLICT against that same partial unique index makes the
   * whole check-and-create atomic - whichever caller loses the race gets
   * DO NOTHING instead of an error, then reads back the row the winner
   * created.
   */
  async ensureDefault(businessId: string, planId: string, trialDays = 14): Promise<SubscriptionRecord> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, current_period_start, current_period_end, trial_ends_at)
       VALUES ($1, $2, 'TRIALING', now(), now() + ($3 || ' days')::interval, now() + ($3 || ' days')::interval)
       ON CONFLICT (business_id) WHERE status = ANY(ARRAY['ACTIVE','TRIALING','PAST_DUE','PAUSED'])
       DO NOTHING
       RETURNING *`,
      [businessId, planId, trialDays],
    );
    const row = rows[0];
    if (row) return toRecord(row);

    // Lost the race - another concurrent call's INSERT already won.
    const existing = await this.findLiveByBusiness(businessId);
    if (!existing) throw new Error('subscriptions insert conflicted but no live subscription was found');
    return existing;
  }

  /**
   * Section 72 (billing preservation / cost control): every TRIALING
   * subscription whose trial_ends_at has already passed and was never
   * converted to a real paying status - the real population
   * subscriptionExpiryService.ts's sweep acts on. Before this existed,
   * trial_ends_at was set correctly at signup (both the 48-hour trial
   * flow and the 14-day interim bootstrap) and even displayed to the
   * business, but nothing ever read it back to actually enforce it -
   * a trial never expired in practice.
   */
  async findExpiredTrials(now = new Date()): Promise<SubscriptionRecord[]> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `SELECT * FROM subscriptions WHERE status = 'TRIALING' AND trial_ends_at IS NOT NULL AND trial_ends_at < $1`,
      [now.toISOString()],
    );
    return rows.map(toRecord);
  }

  /**
   * A real plan-tier change (planUpgradeService.ts, on a verified upgrade
   * payment) - starts a fresh billing cycle from the moment of upgrade
   * (current_period_start reset to now()) rather than leaving the old
   * plan's cycle boundaries in place, since the 5-day proration window
   * planUpgradeService.ts computes is itself measured from
   * current_period_start - leaving it stale would let the same account
   * upgrade "within 5 days" of a cycle that, from the new plan's
   * perspective, never started.
   */
  async changePlan(id: string, planId: string): Promise<void> {
    await this.db.query(
      `UPDATE subscriptions SET plan_id = $2, current_period_start = now(), current_period_end = now() + interval '1 month', updated_at = now() WHERE id = $1`,
      [id, planId],
    );
  }

  /**
   * Creates an ACTIVE subscription for a business that has none, for a
   * payment settled outside the automated checkout.
   *
   * ACTIVE, not TRIALING like ensureDefault: this records a business that
   * has actually paid (cash, a transfer, a webhook that never arrived), and
   * putting them on a trial clock that will expire and lock them out would
   * misrepresent what happened.
   *
   * Same ON CONFLICT guard as ensureDefault against the one-live-per-business
   * partial index, so two admins clicking at once is a handled outcome
   * rather than a constraint violation - the loser reads back the winner's
   * row and the caller's next changePlan() applies to it either way.
   */
  async createManualActive(businessId: string, planId: string): Promise<SubscriptionRecord> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `INSERT INTO subscriptions
         (business_id, plan_id, status, current_period_start, current_period_end, trial_ends_at)
       VALUES ($1, $2, 'ACTIVE', now(), now() + interval '1 month', NULL)
       ON CONFLICT (business_id) WHERE status = ANY(ARRAY['ACTIVE','TRIALING','PAST_DUE','PAUSED'])
       DO NOTHING
       RETURNING *`,
      [businessId, planId],
    );
    const row = rows[0];
    if (row) return toRecord(row);

    const existing = await this.findLiveByBusiness(businessId);
    if (!existing) throw new Error('subscriptions insert conflicted but no live subscription was found');
    return existing;
  }

  /**
   * Pushes a trial's end date out by a number of days, for an admin giving
   * someone more time.
   *
   * Extends from whichever is LATER - the existing end date or now - so
   * "give them 7 more days" means seven days of usable trial in both cases:
   * adding to an end date that has already passed would grant a trial that
   * is still expired. Only ever moves the date forward.
   *
   * Restricted to a TRIALING subscription. Setting a trial end on an ACTIVE
   * paid subscription would be meaningless at best and, since expiry sweeps
   * read trial_ends_at, a way to cancel a paying customer at worst.
   */
  async extendTrial(id: string, days: number): Promise<SubscriptionRecord | null> {
    const { rows } = await this.db.query<SubscriptionRow>(
      `UPDATE subscriptions
       SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($2 || ' days')::interval,
           current_period_end = GREATEST(COALESCE(trial_ends_at, now()), now()) + ($2 || ' days')::interval,
           updated_at = now()
       WHERE id = $1 AND status = 'TRIALING'
       RETURNING *`,
      [id, days],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async updateStatus(id: string, status: SubscriptionStatus): Promise<void> {
    const cancelledAtClause = status === 'CANCELLED' ? ', cancelled_at = now()' : '';
    await this.db.query(`UPDATE subscriptions SET status = $2, updated_at = now()${cancelledAtClause} WHERE id = $1`, [
      id,
      status,
    ]);
  }

  async findById(id: string): Promise<SubscriptionRecord | null> {
    const { rows } = await this.db.query<SubscriptionRow>('SELECT * FROM subscriptions WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }
}
