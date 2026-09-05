import type { Queryable } from './types.js';
import type { PaymentProvider } from '../domain/billing/payment.js';

export type PlanUpgradeStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface PlanUpgradePurchaseRecord {
  id: string;
  businessId: string;
  fromPlanId: string;
  toPlanId: string;
  provider: PaymentProvider;
  status: PlanUpgradeStatus;
  checkoutReference: string;
  wasProrated: boolean;
  fullAmountMinor: number;
  amountMinor: number;
  currency: string;
  providerEventId: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

interface PlanUpgradePurchaseRow {
  id: string;
  business_id: string;
  from_plan_id: string;
  to_plan_id: string;
  provider: PaymentProvider;
  status: PlanUpgradeStatus;
  checkout_reference: string;
  was_prorated: boolean;
  full_amount_minor: string;
  amount_minor: string;
  currency: string;
  provider_event_id: string | null;
  created_at: string;
  verified_at: string | null;
}

function toRecord(row: PlanUpgradePurchaseRow): PlanUpgradePurchaseRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    fromPlanId: row.from_plan_id,
    toPlanId: row.to_plan_id,
    provider: row.provider,
    status: row.status,
    checkoutReference: row.checkout_reference,
    wasProrated: row.was_prorated,
    fullAmountMinor: Number(row.full_amount_minor),
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    providerEventId: row.provider_event_id,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

/**
 * A real, self-serve plan-tier upgrade purchase, mirroring
 * aiTokenTopupRepository.ts's shape closely (checkout row -> verify ->
 * mark). Unlike the top-ups, a verified row here also drives a real
 * subscriptions.plan_id change (planUpgradeService.ts calls
 * subscriptionRepository.changePlan on the same verification path).
 */
export class PlanUpgradeRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: {
    businessId: string;
    fromPlanId: string;
    toPlanId: string;
    provider: PaymentProvider;
    checkoutReference: string;
    wasProrated: boolean;
    fullAmountMinor: number;
    amountMinor: number;
    currency: string;
  }): Promise<PlanUpgradePurchaseRecord> {
    const { rows } = await this.db.query<PlanUpgradePurchaseRow>(
      `INSERT INTO plan_upgrade_purchases (business_id, from_plan_id, to_plan_id, provider, checkout_reference, was_prorated, full_amount_minor, amount_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [input.businessId, input.fromPlanId, input.toPlanId, input.provider, input.checkoutReference, input.wasProrated, input.fullAmountMinor, input.amountMinor, input.currency],
    );
    const row = rows[0];
    if (!row) throw new Error('plan_upgrade_purchases insert returned no row');
    return toRecord(row);
  }

  async findByCheckoutReference(checkoutReference: string): Promise<PlanUpgradePurchaseRecord | null> {
    const { rows } = await this.db.query<PlanUpgradePurchaseRow>(
      `SELECT * FROM plan_upgrade_purchases WHERE checkout_reference = $1`,
      [checkoutReference.trim().toUpperCase()],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Idempotent: a repeat call for an already-VERIFIED row is a no-op success - never re-applies the same plan change twice for one real payment event. */
  async markVerified(checkoutReference: string, providerEventId: string): Promise<{ purchase: PlanUpgradePurchaseRecord; alreadyVerified: boolean }> {
    const existing = await this.findByCheckoutReference(checkoutReference);
    if (!existing) throw new Error('plan_upgrade_purchases: checkout reference not found');
    if (existing.status === 'VERIFIED') return { purchase: existing, alreadyVerified: true };

    const { rows } = await this.db.query<PlanUpgradePurchaseRow>(
      `UPDATE plan_upgrade_purchases SET status = 'VERIFIED', provider_event_id = $2, verified_at = now()
       WHERE checkout_reference = $1 AND status = 'PENDING'
       RETURNING *`,
      [checkoutReference.trim().toUpperCase(), providerEventId],
    );
    const row = rows[0];
    if (!row) throw new Error('plan_upgrade_purchases: could not verify (not PENDING)');
    return { purchase: toRecord(row), alreadyVerified: false };
  }
}
