/**
 * How a business actually gets paid.
 *
 * The important thing this file encodes is that HOW CONFIRMATION ARRIVES is
 * a property of the METHOD, not a setting. A business cannot toggle BiMPay
 * into telling us when money lands, because nothing in BiMPay tells anyone
 * that except a person looking at an app. Making that a capability rather
 * than a configuration is what stops the kitchen gate from ever being
 * opened by a confirmation nobody actually received.
 *
 * Researched September 2026. Where a fact could not be established from
 * the provider's own material it is recorded as unknown rather than
 * guessed, because a payment integration built on an assumption is one
 * that loses somebody's money.
 */

export const FOOD_PAYMENT_METHODS = [
  'CASH',
  'BANK_TRANSFER',
  /** Barbados' national instant payment system. Request-to-pay and merchant QR. */
  'BIMPAY',
  /** CIBC Caribbean's person-to-person transfer by email or mobile number. */
  'ONE_STPAY',
  /** WiPay Caribbean - hosted card checkout, settles BBD locally. */
  'WIPAY',
  /** First Atlantic Commerce. Card acquiring, needs a merchant account through a bank. */
  'FAC',
  'CARD_IN_PERSON',
  'ON_ACCOUNT',
  'OTHER',
] as const;

export type FoodPaymentMethodKey = (typeof FOOD_PAYMENT_METHODS)[number];

export type ConfirmationKind =
  /**
   * Somebody has to look and say the money arrived. Not a shortcoming to
   * be worked around - for most of these it is the only truthful answer
   * available.
   */
  | 'MANUAL'
  /**
   * The customer is returned to us after paying, which is evidence but not
   * proof: a customer who pays and closes the browser never comes back. So
   * this lands on AWAITING_VERIFICATION, never straight on PAID.
   */
  | 'RETURN_REDIRECT'
  /** The provider tells our server, server to server. Only this one can be trusted unattended. */
  | 'SERVER_CALLBACK';

export interface PaymentMethodCapability {
  key: FoodPaymentMethodKey;
  label: string;
  /** What an owner needs to know before switching it on, in their terms. */
  description: string;
  confirmation: ConfirmationKind;
  /**
   * Whether AURA can create the request for payment itself.
   *
   * False for BiMPay and 1stPay: both are requested from a bank's own app
   * by a person. AURA can tell the customer what to pay, to whom, and
   * against which order - it simply cannot press the button in somebody
   * else's banking app, and pretending otherwise would leave an operator
   * believing a request went out that never did.
   */
  auraCanRequest: boolean;
  /** A handle the customer pays TO - a BiMPay alias, a number, an account. */
  needsAlias: boolean;
  aliasLabel: string | null;
  /** Set when the integration is not built yet, so nothing can be switched on that would silently do nothing. */
  notYetIntegrated: boolean;
}

export const PAYMENT_METHOD_CAPABILITIES: Record<FoodPaymentMethodKey, PaymentMethodCapability> = {
  CASH: {
    key: 'CASH',
    label: 'Cash',
    description: 'Paid at the counter or to the driver. Somebody ticks it off.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: false,
    aliasLabel: null,
    notYetIntegrated: false,
  },
  BANK_TRANSFER: {
    key: 'BANK_TRANSFER',
    label: 'Bank transfer',
    description: 'You send your account details and confirm when the money lands.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: true,
    aliasLabel: 'Account details to give the customer',
    notYetIntegrated: false,
  },
  BIMPAY: {
    key: 'BIMPAY',
    label: 'BiMPay',
    description:
      'Barbados’ instant payment system. We message the customer your alias, the amount and the order number, ' +
      'and you confirm when it arrives — instantly, in your own app. We cannot send the request-to-pay for you: ' +
      'that is created in your bank’s app, not by us.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: true,
    aliasLabel: 'Your BiMPay alias or number',
    notYetIntegrated: false,
  },
  ONE_STPAY: {
    key: 'ONE_STPAY',
    label: 'CIBC 1stPay',
    description:
      'Transfer by email address or mobile number, for CIBC Caribbean customers. Same as BiMPay from our side: we ' +
      'tell the customer where to send it, you confirm when it arrives.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: true,
    aliasLabel: 'The email or mobile number to pay',
    notYetIntegrated: false,
  },
  WIPAY: {
    key: 'WIPAY',
    label: 'WiPay (card)',
    description:
      'A card payment link. The customer is returned to us after paying, which marks the order as needing a quick ' +
      'check rather than paid outright — somebody who pays and closes their browser never comes back.',
    // Deliberately NOT a server callback. Every integration found for
    // WiPay Caribbean confirms payment on the return redirect; no
    // server-to-server webhook could be established from their own
    // material, so this does not claim one.
    confirmation: 'RETURN_REDIRECT',
    auraCanRequest: true,
    needsAlias: false,
    aliasLabel: null,
    notYetIntegrated: true,
  },
  FAC: {
    key: 'FAC',
    label: 'First Atlantic Commerce (card)',
    description: 'Card acquiring through your bank. The fullest option and the most paperwork to open.',
    confirmation: 'SERVER_CALLBACK',
    auraCanRequest: true,
    needsAlias: false,
    aliasLabel: null,
    notYetIntegrated: true,
  },
  CARD_IN_PERSON: {
    key: 'CARD_IN_PERSON',
    label: 'Card machine',
    description: 'Your own terminal, at the counter or on a delivery.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: false,
    aliasLabel: null,
    notYetIntegrated: false,
  },
  ON_ACCOUNT: {
    key: 'ON_ACCOUNT',
    label: 'On account',
    description: 'A known customer who settles later. Set their standing terms under pay-on-delivery.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: false,
    aliasLabel: null,
    notYetIntegrated: false,
  },
  OTHER: {
    key: 'OTHER',
    label: 'Something else',
    description: 'Anything you settle your own way.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: false,
    aliasLabel: null,
    notYetIntegrated: false,
  },
};

/**
 * Whether a method may be switched on at all.
 *
 * An integration that is not built cannot be enabled, so an owner can
 * never turn on a payment method that would silently do nothing and leave
 * orders sitting unpaid behind the kitchen gate.
 */
export function canEnable(method: FoodPaymentMethodKey): boolean {
  return !PAYMENT_METHOD_CAPABILITIES[method].notYetIntegrated;
}

/** Methods a business can actually use today. */
export function availableMethods(): PaymentMethodCapability[] {
  return FOOD_PAYMENT_METHODS.map((key) => PAYMENT_METHOD_CAPABILITIES[key]).filter((method) => !method.notYetIntegrated);
}
