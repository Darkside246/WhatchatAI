/**
 * PayPal adapter (Section 73-74) - second real payment provider after
 * BiMPay. Unlike BiMPay's manual bank-transfer memo, PayPal needs a live
 * OAuth2 + Orders-API round trip to create a real checkout, and a live
 * call to PayPal's own webhook-signature-verification endpoint to trust an
 * incoming event (local cert-chain verification is the unsupported hard
 * way) - both genuinely async, matching the widened PaymentProviderAdapter
 * contract in types.ts.
 *
 * Required env vars: PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_ENV
 * ('sandbox' default, 'live' opt-in). PAYPAL_WEBHOOK_ID is passed in via
 * VerifyEventContext.secret by billingRoutes.ts's resolveProviderSecret,
 * the same role BiMPay's shared HMAC secret plays there.
 */
import { z } from 'zod';
import type { PaymentProviderAdapter, VerifyEventContext, VerifyEventResult } from './types.js';

interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  baseUrl: string;
}

function paypalConfig(): PayPalConfig | null {
  const clientId = process.env['PAYPAL_CLIENT_ID'];
  const clientSecret = process.env['PAYPAL_CLIENT_SECRET'];
  if (!clientId || !clientSecret) return null;
  const live = process.env['PAYPAL_ENV'] === 'live';
  return { clientId, clientSecret, baseUrl: live ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com' };
}

async function getAccessToken(cfg: PayPalConfig): Promise<string> {
  const resp = await fetch(`${cfg.baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });
  if (!resp.ok) throw new Error(`PayPal OAuth token request failed: ${await resp.text()}`);
  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('PayPal OAuth token response had no access_token');
  return data.access_token;
}

async function buildCheckoutInstructions(checkoutReference: string, input: { amountMinor: number; currency: string }): Promise<Record<string, unknown>> {
  const cfg = paypalConfig();
  if (!cfg) throw new Error('PayPal is not configured (missing PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).');
  const accessToken = await getAccessToken(cfg);

  // PayPal's Orders API wants a decimal string amount, not minor units.
  const value = (input.amountMinor / 100).toFixed(2);
  const resp = await fetch(`${cfg.baseUrl}/v2/checkout/orders`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ custom_id: checkoutReference, amount: { currency_code: input.currency.toUpperCase(), value } }],
    }),
  });
  if (!resp.ok) throw new Error(`PayPal order creation failed: ${await resp.text()}`);
  const order = (await resp.json()) as { id: string; links?: { rel: string; href: string }[] };
  const approvalUrl = order.links?.find((link) => link.rel === 'approve')?.href ?? null;

  return { provider: 'paypal', orderId: order.id, approvalUrl, reference: checkoutReference, currency: input.currency, amountMinor: input.amountMinor };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Only PAYMENT.CAPTURE.COMPLETED represents money actually settling -
// CHECKOUT.ORDER.APPROVED and everything else is real but not actionable
// here (see the 'ignored' outcome's own doc comment in types.ts).
const captureCompletedSchema = z.object({
  id: z.string().trim().min(1),
  event_type: z.literal('PAYMENT.CAPTURE.COMPLETED'),
  resource: z.object({
    custom_id: z.string().trim().min(1),
    amount: z.object({ currency_code: z.string().trim().length(3), value: z.string().trim().min(1) }),
  }),
});

const knownEventTypeSchema = z.object({ event_type: z.string().trim().min(1) });

async function verifyEvent(ctx: VerifyEventContext): Promise<VerifyEventResult> {
  const cfg = paypalConfig();
  if (!cfg) return { outcome: 'rejected', reason: 'PAYPAL_NOT_CONFIGURED' };
  if (!ctx.secret) return { outcome: 'rejected', reason: 'PAYPAL_WEBHOOK_ID_NOT_CONFIGURED' };

  const transmissionId = headerValue(ctx.headers['paypal-transmission-id']);
  const transmissionTime = headerValue(ctx.headers['paypal-transmission-time']);
  const transmissionSig = headerValue(ctx.headers['paypal-transmission-sig']);
  const certUrl = headerValue(ctx.headers['paypal-cert-url']);
  const authAlgo = headerValue(ctx.headers['paypal-auth-algo']);
  if (!transmissionId || !transmissionTime || !transmissionSig || !certUrl || !authAlgo) {
    return { outcome: 'rejected', reason: 'MISSING_PAYPAL_WEBHOOK_HEADERS' };
  }

  let accessToken: string;
  try {
    accessToken = await getAccessToken(cfg);
  } catch {
    return { outcome: 'rejected', reason: 'PAYPAL_AUTH_UNAVAILABLE' };
  }

  const verifyResp = await fetch(`${cfg.baseUrl}/v1/notifications/verify-webhook-signature`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      transmission_id: transmissionId,
      transmission_time: transmissionTime,
      cert_url: certUrl,
      auth_algo: authAlgo,
      transmission_sig: transmissionSig,
      webhook_id: ctx.secret,
      webhook_event: ctx.body,
    }),
  });
  if (!verifyResp.ok) return { outcome: 'rejected', reason: 'PAYPAL_VERIFY_REQUEST_FAILED' };
  const verification = (await verifyResp.json()) as { verification_status?: string };
  if (verification.verification_status !== 'SUCCESS') return { outcome: 'rejected', reason: 'INVALID_PAYPAL_SIGNATURE' };

  // Signature is genuine from here on - any further rejection is really an
  // "ignored" (a real, verified event we don't act on), never a security
  // rejection.
  const capture = captureCompletedSchema.safeParse(ctx.body);
  if (!capture.success) {
    const known = knownEventTypeSchema.safeParse(ctx.body);
    return { outcome: 'ignored', reason: known.success ? `UNHANDLED_PAYPAL_EVENT_TYPE:${known.data.event_type}` : 'MALFORMED_PAYPAL_EVENT' };
  }

  const amountMinor = Math.round(Number(capture.data.resource.amount.value) * 100);
  return {
    outcome: 'verified',
    checkoutReference: capture.data.resource.custom_id,
    amountMinor,
    currency: capture.data.resource.amount.currency_code,
    providerEventId: capture.data.id,
  };
}

export const paypalProvider: PaymentProviderAdapter = {
  kind: 'paypal',
  buildCheckoutInstructions,
  verifyEvent,
};
