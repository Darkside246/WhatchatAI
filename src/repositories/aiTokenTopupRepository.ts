import type { Queryable } from './types.js';
import type { PaymentProvider } from '../domain/billing/payment.js';

export type AiTokenTopupStatus = 'PENDING' | 'VERIFIED' | 'REJECTED';

export interface AiTokenTopupPurchaseRecord {
  id: string;
  businessId: string;
  provider: PaymentProvider;
  status: AiTokenTopupStatus;
  checkoutReference: string;
  tokensPurchased: number;
  amountMinor: number;
  currency: string;
  providerEventId: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

interface AiTokenTopupPurchaseRow {
  id: string;
  business_id: string;
  provider: PaymentProvider;
  status: AiTokenTopupStatus;
  checkout_reference: string;
  tokens_purchased: string;
  amount_minor: string;
  currency: string;
  provider_event_id: string | null;
  created_at: string;
  verified_at: string | null;
}

function toRecord(row: AiTokenTopupPurchaseRow): AiTokenTopupPurchaseRecord {
  return {
    id: row.id,
    businessId: row.business_id,
    provider: row.provider,
    status: row.status,
    checkoutReference: row.checkout_reference,
    tokensPurchased: Number(row.tokens_purchased),
    amountMinor: Number(row.amount_minor),
    currency: row.currency,
    providerEventId: row.provider_event_id,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

/**
 * Section 34-40's real budget-override flow (a self-serve token top-up
 * purchase) - deliberately its own small table, not payment_attempts (see
 * migration 980's own doc comment for why). Mirrors paymentService.ts's
 * shape closely (checkout row -> verify -> mark) without any of the
 * product-account activation logic that pipeline needs and this one
 * doesn't.
 */
export class AiTokenTopupRepository {
  constructor(private readonly db: Queryable) {}

  async create(input: { businessId: string; provider: PaymentProvider; checkoutReference: string; tokensPurchased: number; amountMinor: number; currency: string }): Promise<AiTokenTopupPurchaseRecord> {
    const { rows } = await this.db.query<AiTokenTopupPurchaseRow>(
      `INSERT INTO ai_token_topup_purchases (business_id, provider, checkout_reference, tokens_purchased, amount_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [input.businessId, input.provider, input.checkoutReference, input.tokensPurchased, input.amountMinor, input.currency],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_token_topup_purchases insert returned no row');
    return toRecord(row);
  }

  async findByCheckoutReference(checkoutReference: string): Promise<AiTokenTopupPurchaseRecord | null> {
    const { rows } = await this.db.query<AiTokenTopupPurchaseRow>(
      `SELECT * FROM ai_token_topup_purchases WHERE checkout_reference = $1`,
      [checkoutReference.trim().toUpperCase()],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Idempotent: a repeat call for an already-VERIFIED row with the same
   * providerEventId is a no-op success (same shape as
   * paymentService.ts's activateVerifiedPayment guard) - never
   * double-credits a business's token budget for one real payment event.
   */
  async markVerified(checkoutReference: string, providerEventId: string): Promise<{ purchase: AiTokenTopupPurchaseRecord; alreadyVerified: boolean }> {
    const existing = await this.findByCheckoutReference(checkoutReference);
    if (!existing) throw new Error('ai_token_topup_purchases: checkout reference not found');
    if (existing.status === 'VERIFIED') return { purchase: existing, alreadyVerified: true };

    const { rows } = await this.db.query<AiTokenTopupPurchaseRow>(
      `UPDATE ai_token_topup_purchases SET status = 'VERIFIED', provider_event_id = $2, verified_at = now()
       WHERE checkout_reference = $1 AND status = 'PENDING'
       RETURNING *`,
      [checkoutReference.trim().toUpperCase(), providerEventId],
    );
    const row = rows[0];
    if (!row) throw new Error('ai_token_topup_purchases: could not verify (not PENDING)');
    return { purchase: toRecord(row), alreadyVerified: false };
  }

  /**
   * Real sum of this business's verified top-ups for the current UTC
   * calendar month - the exact same real-UTC-month expression
   * aiUsageRepository.ts's getMonthlyTotalForBusiness had to be fixed to
   * use this session (Section 68 follow-up: date_trunc('month', now())
   * truncates in the DB session's timezone unless forced to UTC). Never
   * reintroduce that bug here.
   */
  async getVerifiedTokensThisMonthForBusiness(businessId: string): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT COALESCE(sum(tokens_purchased), 0) AS total
       FROM ai_token_topup_purchases
       WHERE business_id = $1 AND status = 'VERIFIED'
         AND verified_at >= date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
      [businessId],
    );
    return Number(rows[0]?.total ?? 0);
  }
}
