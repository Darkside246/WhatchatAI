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
  /**
   * A real, signature-verified event the caller deliberately takes no
   * action on (e.g. PayPal's CHECKOUT.ORDER.APPROVED - authorized but not
   * yet captured, so there is nothing to activate yet). Distinct from
   * `rejected`: the webhook call itself is genuine and should be
   * acknowledged 200 so the provider doesn't retry it forever, not treated
   * as an error.
   */
  | { outcome: 'ignored'; reason: string }
  | { outcome: 'rejected'; reason: string };

export interface PaymentProviderAdapter {
  readonly kind: string;
  /**
   * BiMPay's checkout is a static bank-transfer memo, computed with no
   * network call - synchronous. PayPal's real checkout requires a live
   * OAuth2 + Orders-API round trip, so this may also return a Promise;
   * both call sites (billingRoutes.ts) already run inside async handlers.
   */
  buildCheckoutInstructions(checkoutReference: string, input: { amountMinor: number; currency: string }): Record<string, unknown> | Promise<Record<string, unknown>>;
  /**
   * Parse + signature verification. No DB access. BiMPay's is pure local
   * HMAC comparison - synchronous. PayPal's real verification calls
   * PayPal's own /v1/notifications/verify-webhook-signature endpoint, so
   * this may also return a Promise.
   */
  verifyEvent(ctx: VerifyEventContext): VerifyEventResult | Promise<VerifyEventResult>;
}
