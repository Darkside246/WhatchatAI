/**
 * WiPay (Section 73-74) - registry slot only, deliberately inert.
 *
 * Researched two realistic Barbados card-processing options: First
 * Atlantic Commerce/Powertranz (established, PCI DSS Level 1, but needs a
 * real bank-issued merchant account before it can go live) and WiPay (an
 * aggregator on top of FAC, no separate merchant account needed - faster
 * for a small business to actually get live). The user chose to build
 * toward WiPay. Its real API/webhook documentation sits behind a
 * JS-rendered site that could not be fetched, so its exact webhook payload
 * shape and signature-verification scheme are not actually known here.
 *
 * A forged webhook fraudulently activating a real subscription is a real
 * financial risk, so this adapter never invents a verification scheme to
 * fill that gap - it always rejects, explicitly and honestly. Once the
 * business signs up with WiPay and its real API/webhook docs are
 * available, this file's verifyEvent gets replaced with a real
 * implementation the same way bimpayProvider.ts/paypalProvider.ts are
 * implemented - the registry/toggle/schema plumbing elsewhere in the
 * codebase needs no further changes when that happens.
 */
import type { PaymentProviderAdapter, VerifyEventContext, VerifyEventResult } from './types.js';

function buildCheckoutInstructions(): Record<string, unknown> {
  throw new Error('WiPay checkout is not yet implemented - see wipayProvider.ts for what is still needed.');
}

function verifyEvent(_ctx: VerifyEventContext): VerifyEventResult {
  return { outcome: 'rejected', reason: 'WIPAY_INTEGRATION_NOT_YET_IMPLEMENTED' };
}

export const wipayProvider: PaymentProviderAdapter = {
  kind: 'wipay',
  buildCheckoutInstructions,
  verifyEvent,
};
