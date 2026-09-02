import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { buildBiMPaySignature } from '../paymentService.js';
import type { PaymentProviderAdapter, VerifyEventContext, VerifyEventResult } from './types.js';

const bridgeSchema = z.object({
  checkoutReference: z.string().trim().min(4).max(64),
  amountMinor: z.number().int().positive(),
  currency: z.string().trim().length(3),
  providerEventId: z.string().trim().min(1).max(200),
  receivedAt: z.coerce.date().optional(),
});

function verifyEvent(ctx: VerifyEventContext): VerifyEventResult {
  const parsed = bridgeSchema.safeParse(ctx.body);
  if (!parsed.success) return { outcome: 'rejected', reason: 'INVALID_BIMPAY_EVENT' };

  // receivedAt is deliberately excluded from the canonical signature
  // string (see buildBiMPaySignature's own parameter type), so it's not
  // part of this input.
  const signatureInput: Parameters<typeof buildBiMPaySignature>[0] = {
    provider: 'BIMPAY',
    checkoutReference: parsed.data.checkoutReference,
    amountMinor: parsed.data.amountMinor,
    currency: parsed.data.currency,
    providerEventId: parsed.data.providerEventId,
  };

  const receivedHeader = ctx.headers['x-bimpay-signature'];
  const receivedSignature = Array.isArray(receivedHeader) ? (receivedHeader[0] ?? '') : (receivedHeader ?? '');
  const expectedSignature = buildBiMPaySignature(signatureInput, ctx.secret);
  const expected = Buffer.from(expectedSignature, 'utf8');
  const received = Buffer.from(receivedSignature, 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { outcome: 'rejected', reason: 'INVALID_BIMPAY_SIGNATURE' };
  }

  const result: VerifyEventResult = {
    outcome: 'verified',
    checkoutReference: parsed.data.checkoutReference,
    amountMinor: parsed.data.amountMinor,
    currency: parsed.data.currency,
    providerEventId: parsed.data.providerEventId,
  };
  if (parsed.data.receivedAt !== undefined) result.receivedAt = parsed.data.receivedAt;
  return result;
}

function buildCheckoutInstructions(checkoutReference: string, input: { amountMinor: number; currency: string }): Record<string, unknown> {
  return {
    reference: checkoutReference,
    currency: input.currency,
    amountMinor: input.amountMinor,
    memoRequired: true,
    memoInstruction: `Enter ${checkoutReference} in the BiMPay transfer reference/memo.`,
  };
}

export const bimpayProvider: PaymentProviderAdapter = {
  kind: 'bimpay',
  buildCheckoutInstructions,
  verifyEvent,
};
