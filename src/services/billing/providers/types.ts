/**
 * Adapter `kind` is a lowercase, route-param-shaped registry key
 * ('bimpay') - distinct from the uppercase, DB-facing `PaymentProvider`
 * enum in ../../../domain/billing/payment.js ('BIMPAY'). Callers resolve
 * an adapter via `resolveProvider(dbProviderValue.toLowerCase())`.
 */
/**
 * `body` is the already JSON-parsed request body (this repo's existing
 * convention - BiMPay's HMAC is computed over selected canonical fields,
 * not the raw request bytes). A future provider whose signature scheme
 * needs the literal raw byte buffer (e.g. Stripe's own SDK verifier)
 * will need this context shape extended when it's actually added - not
 * anticipated here.
 */
export interface VerifyEventContext {
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
  secret: string;
}

export type VerifyEventResult =
  | {
      outcome: 'verified';
      checkoutReference: string;
      amountMinor: number;
      currency: string;
      providerEventId: string;
      receivedAt?: Date;
    }
  | { outcome: 'rejected'; reason: string };

export interface PaymentProviderAdapter {
  readonly kind: string;
  buildCheckoutInstructions(checkoutReference: string, input: { amountMinor: number; currency: string }): Record<string, unknown>;
  /** Pure: parse + signature verification only. No DB access. */
  verifyEvent(ctx: VerifyEventContext): VerifyEventResult;
}
