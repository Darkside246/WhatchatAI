import type { Queryable } from './types.js';
import type { PaymentProvider } from '../domain/billing/payment.js';

export type AiMemoryTopupStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface AiMemoryTopupPurchaseRecord {
  id: string;
  businessId: string;
  provider: PaymentProvider;
  status: AiMemoryTopupStatus;
  checkoutReference: string;
  profilesPurchased: number;
  amountMinor: number;
  currency: string;
  providerEventId: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

interface AiMemoryTopupPurchaseRow {
  id: string;
  business_id: string;
  provider: PaymentProvider;
  status: AiMemoryTopupStatus;
  checkout_reference: string;
  profiles_purchased: string;
  amount_minor: string;
  currency: string;
  provider_event_id: string | null;
  created_at: string;
  verified_at: string | null;
}

function toRecord(row: AiMemoryTopupPurchaseRow): AiMemoryTopupPurchaseRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    provider: row.provider,
    status: row.status,
    checkoutReference: row.checkout_reference,
    profilesPurchased: Number(row.profiles_purchased),
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    providerEventId: row.provider_event_id,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

/**
 * A real, self-serve AI-memory-capacity top-up purchase, mirroring
 * aiTokenTopupRepository.ts's shape closely (checkout row -> verify ->
 * mark). The one real difference: getVerifiedProfilesForBusiness sums
 * ALL verified purchases ever, not just this calendar month's - memory
 * capacity is a standing cap a business permanently keeps, never a
 * consumable that resets on the 1st the way AI tokens do.
 */
export class AiMemoryTopupRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { businessId: string; provider: PaymentProvider; checkoutReference: string; profilesPurchased: number; amountMinor: number; currency: string }): Promise<AiMemoryTopupPurchaseRecord> {
    const { rows } = await this.db.query<AiMemoryTopupPurchaseRow>(
      `INSERT INTO ai_memory_topup_purchases (business_id, provider, checkout_reference, profiles_purchased, amount_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.businessId, input.provider, input.checkoutReference, input.profilesPurchased, input.amountMinor, input.currency],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_memory_topup_purchases insert returned no row');
    return toRecord(row);
  }

  async findByCheckoutReference(checkoutReference: string): Promise<AiMemoryTopupPurchaseRecord | null> {
    const { rows } = await this.db.query<AiMemoryTopupPurchaseRow>(
      `SELECT * FROM ai_memory_topup_purchases WHERE checkout_reference = $1`,
      [checkoutReference.trim().toUpperCase()],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** Idempotent: a repeat call for an already-VERIFIED row is a no-op success - never double-credits a business's memory capacity for one real payment event. */
  async markVerified(checkoutReference: string, providerEventId: string): Promise<{ purchase: AiMemoryTopupPurchaseRecord; alreadyVerified: boolean }> {
    const existing = await this.findByCheckoutReference(checkoutReference);
    if (!existing) throw new Error('ai_memory_topup_purchases: checkout reference not found');
    if (existing.status === 'VERIFIED') return { purchase: existing, alreadyVerified: true };

    const { rows } = await this.db.query<AiMemoryTopupPurchaseRow>(
      `UPDATE ai_memory_topup_purchases SET status = 'VERIFIED', provider_event_id = $2, verified_at = now()
       WHERE checkout_reference = $1 AND status = 'PENDING'
       RETURNING *`,
      [checkoutReference.trim().toUpperCase(), providerEventId],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_memory_topup_purchases: could not verify (not PENDING)');
    return { purchase: toRecord(row), alreadyVerified: false };
  }

  /** Real, lifetime sum of this business's verified memory top-ups - deliberately never time-boxed, unlike getVerifiedTokensThisMonthForBusiness. */
  async getVerifiedProfilesForBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT COALESCE(sum(profiles_purchased), 0) AS total FROM ai_memory_topup_purchases WHERE business_id = $1 AND status = 'VERIFIED'`,
      [businessId],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
