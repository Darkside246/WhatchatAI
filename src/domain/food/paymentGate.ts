/**
 * Whether an order may be sent to the kitchen yet.
 *
 * THE RULE THIS EXISTS FOR. A kitchen that cooks before payment clears is
 * a kitchen giving away food. So payment is not a status that happens to
 * sit beside an order - it is the gate on the one handover that costs real
 * money, the move from a taken order to a pan on a hob.
 *
 * WHY PAYMENT IS ITS OWN STATE MACHINE. Where an order is in the kitchen
 * and whether it has been paid for are genuinely independent questions: an
 * order can be paid and not yet started, started and refunded, delivered
 * and still awaiting a bank transfer to land. Collapsing both into one
 * status field forces a false ordering on them and produces states that
 * cannot describe what is actually true.
 *
 * They are therefore separate, and tied together at EXACTLY ONE POINT -
 * releaseToKitchen below. One place to read, one place to change, and no
 * way for a caller to find a second route past it.
 */

export const FOOD_PAYMENT_STATES = [
  /**
   * This business does not gate the kitchen on payment - a cash counter, a
   * regular account trade. Distinct from WAIVED: nothing was waived,
   * because nothing was required.
   */
  'NOT_REQUIRED',
  /** Payment is required and has not arrived. */
  'UNPAID',
  /**
   * The customer says they have paid and nothing has confirmed it.
   *
   * This BLOCKS the kitchen, deliberately. "I sent it" is a claim, not a
   * receipt, and a bank transfer that never lands is the single most
   * common way a small food business loses an order's worth of food.
   */
  'AWAITING_VERIFICATION',
  /** Confirmed by a provider, a reconciled transfer, or a person who checked. */
  'PAID',
  /**
   * Deliberately released without payment - a known customer paying cash on
   * delivery, or an owner's one-off decision. Always attributable: see
   * PaymentWaiver.
   */
  'WAIVED',
  'REFUNDED',
  'FAILED',
] as const;

export type FoodPaymentState = (typeof FOOD_PAYMENT_STATES)[number];

export type FoodPaymentMethod = 'CASH' | 'BANK_TRANSFER' | 'CARD' | 'MOBILE' | 'ON_ACCOUNT' | 'OTHER';

/**
 * The states that let food start being made.
 *
 * A short, explicit allow-list rather than a list of blockers, so a state
 * added later is closed by default. A new payment state that should open
 * the gate has to be added here on purpose - which is the right way round
 * for a rule about giving away food.
 */
const RELEASING_STATES: readonly FoodPaymentState[] = ['PAID', 'WAIVED', 'NOT_REQUIRED'];

export function paymentReleasesKitchen(state: FoodPaymentState): boolean {
  return RELEASING_STATES.includes(state);
}

/**
 * Legal payment-state moves.
 *
 * NOT_REQUIRED is reachable from nothing: whether a business gates on
 * payment is a setting applied when the order is created, never a thing
 * that changes under a live order. An owner turning the gate on halfway
 * through service must not silently re-open orders already released.
 */
const ALLOWED_PAYMENT_TRANSITIONS: Record<FoodPaymentState, readonly FoodPaymentState[]> = {
  NOT_REQUIRED: ['PAID', 'REFUNDED'],
  UNPAID: ['AWAITING_VERIFICATION', 'PAID', 'WAIVED', 'FAILED'],
  AWAITING_VERIFICATION: ['PAID', 'UNPAID', 'WAIVED', 'FAILED'],
  // Refunding is the only way out of paid. Going back to UNPAID would erase
  // the fact that money arrived, which is a financial record, not a status.
  PAID: ['REFUNDED'],
  // A waiver can be revoked while the order is still live - an owner who
  // extended terms and then thought better of it.
  WAIVED: ['UNPAID', 'PAID', 'REFUNDED'],
  REFUNDED: [],
  FAILED: ['UNPAID', 'AWAITING_VERIFICATION', 'PAID'],
};

export function canTransitionPayment(from: FoodPaymentState, to: FoodPaymentState): boolean {
  return ALLOWED_PAYMENT_TRANSITIONS[from].includes(to);
}

export function allowedNextPaymentStates(from: FoodPaymentState): readonly FoodPaymentState[] {
  return ALLOWED_PAYMENT_TRANSITIONS[from];
}

/** Why an order was released without payment, and on whose authority. Never inferred. */
export interface PaymentWaiver {
  /** 'customer_terms' - standing pay-on-delivery terms; 'manual' - a one-off decision by an authorised person. */
  kind: 'customer_terms' | 'manual';
  reason: string;
}

export type KitchenRelease =
  | { released: true; via: 'payment' | 'not_required' | 'customer_terms' | 'manual_override' }
  | { released: false; reason: string; customerFacing: string };

export interface ReleaseInput {
  paymentState: FoodPaymentState;
  /** The business setting. False means this kitchen does not wait for money. */
  paymentRequiredBeforeKitchen: boolean;
  /** Standing terms for this customer - a known face who pays on delivery. */
  customerMayPayOnDelivery?: boolean;
  /** A one-off decision by somebody holding food.approve, already audited by the caller. */
  manualOverride?: { by: string; reason: string } | undefined;
}

/**
 * The single gate. Everything that wants to start cooking comes through here.
 *
 * Returns a customer-facing sentence alongside the operational reason,
 * because a blocked order is not an error to be swallowed - somebody is
 * waiting on food and is entitled to know why it has not started.
 */
export function releaseToKitchen(input: ReleaseInput): KitchenRelease {
  // An explicit, audited decision by a person outranks the rule. It is
  // checked first so an owner standing in front of a customer is never
  // argued with by software.
  if (input.manualOverride) {
    return { released: true, via: 'manual_override' };
  }

  if (!input.paymentRequiredBeforeKitchen) {
    return { released: true, via: 'not_required' };
  }

  if (input.paymentState === 'PAID') return { released: true, via: 'payment' };
  if (input.paymentState === 'WAIVED') return { released: true, via: 'customer_terms' };
  if (input.paymentState === 'NOT_REQUIRED') return { released: true, via: 'not_required' };

  // Standing terms release the order, but they do NOT quietly mark it paid -
  // the money is still owed, and an order that says PAID when nobody has
  // paid would corrupt the one record an owner reconciles against.
  if (input.customerMayPayOnDelivery) {
    return { released: true, via: 'customer_terms' };
  }

  if (input.paymentState === 'AWAITING_VERIFICATION') {
    return {
      released: false,
      reason: 'The customer reports having paid, but the payment has not been verified.',
      customerFacing: 'We can see your order — we just need to confirm the payment before the kitchen starts. We will let you know the moment it clears.',
    };
  }

  if (input.paymentState === 'REFUNDED') {
    return {
      released: false,
      reason: 'This order has been refunded.',
      customerFacing: 'This order was refunded, so it has not been sent to the kitchen. Let us know if you would like to order again.',
    };
  }

  if (input.paymentState === 'FAILED') {
    return {
      released: false,
      reason: 'The payment failed.',
      customerFacing: 'The payment did not go through, so the kitchen has not started. Would you like to try again?',
    };
  }

  return {
    released: false,
    reason: 'Payment has not been received.',
    customerFacing: 'Thanks — your order is saved. We start cooking as soon as the payment comes through.',
  };
}
