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

/**
 * How a customer addresses a payment.
 *
 * BiMPay supports three aliases alongside the account number - email,
 * mobile number and nickname - and which one a business registered changes
 * what we tell the customer to type. "Send it to 2460000000" and "send it
 * to pay@shop.bb" are not interchangeable sentences.
 */
export const PAYMENT_ALIAS_KINDS = ['EMAIL', 'MOBILE', 'NICKNAME', 'ACCOUNT_NUMBER'] as const;
export type PaymentAliasKind = (typeof PAYMENT_ALIAS_KINDS)[number];

export const ALIAS_KIND_LABEL: Record<PaymentAliasKind, string> = {
  EMAIL: 'email address',
  MOBILE: 'mobile number',
  NICKNAME: 'nickname',
  ACCOUNT_NUMBER: 'account number',
};

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
  /**
   * Whether a completed payment can be pulled back.
   *
   * BiMPay settles in real time and cannot be reversed AUTOMATICALLY. The
   * Central Bank describes a "Request-for-Recall" procedure run through
   * the sender's own institution, but it needs the recipient's agreement -
   * so from this software's side the money is not coming back on its own.
   *
   * Two consequences, both of which change what we should say and do:
   * a refund here is a NEW payment going out rather than a reversal of one
   * that came in, and there is no chargeback to fear once money has
   * arrived. That second one is why a business can safely cook on
   * confirmation.
   */
  irrevocable: boolean;
  /** Which alias kinds this method accepts, when it uses one. */
  aliasKinds: readonly PaymentAliasKind[];
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
    irrevocable: false,
    aliasKinds: [],
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
    irrevocable: false,
    aliasKinds: ['ACCOUNT_NUMBER'],
  },
  BIMPAY: {
    key: 'BIMPAY',
    label: 'BiMPay',
    description:
      'Barbados’ instant payment system. We message the customer your alias, the amount and the order number, and ' +
      'you confirm when it arrives — in real time, in your own app. Money cannot be pulled back once sent, so a ' +
      'confirmed BiMPay payment cannot be cancelled on you. We cannot create the request-to-pay for you: that is ' +
      'made in your bank’s app, not by us.',
    confirmation: 'MANUAL',
    auraCanRequest: false,
    needsAlias: true,
    aliasLabel: 'Your BiMPay alias or number',
    notYetIntegrated: false,
    irrevocable: true,
    aliasKinds: ['MOBILE', 'EMAIL', 'NICKNAME', 'ACCOUNT_NUMBER'],
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
    irrevocable: false,
    aliasKinds: ['EMAIL', 'MOBILE'],
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
    irrevocable: false,
    aliasKinds: [],
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
    irrevocable: false,
    aliasKinds: [],
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
    irrevocable: false,
    aliasKinds: [],
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
    irrevocable: false,
    aliasKinds: [],
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
    irrevocable: false,
    aliasKinds: [],
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
/**
 * What BiMPay can and cannot do for a food business, as of September 2026.
 *
 * Written down because the roll-out is phased and the phase matters. From
 * the Central Bank's own material:
 *
 *   - Phase 1's e-wallet is aimed at individuals making person-to-person
 *     payments. A micro-merchant - somebody running an informal business -
 *     can receive payment into that individual wallet, which is exactly
 *     what a one-van roti business will do.
 *   - The MERCHANT wallet, with a merchant app carrying product prices and
 *     fuller transaction reports, arrives in phase 2.
 *   - Request-to-pay, bulk payments and QR codes are business features of
 *     the system, reached through a participant's own app.
 *   - The secure APIs the Central Bank describes are between PARTICIPANTS
 *     - banks, credit unions and payment service providers - over ISO
 *     20022. Becoming a participant is how a platform would connect
 *     directly, and the material says other payment service providers can
 *     come on board over time. That is a licensing route, not an
 *     integration one, and nothing here assumes it.
 *   - Local payments and BBD only in phase 1.
 *
 * The practical consequence for this software: confirmation stays a human
 * act, and the useful work is making the ask unambiguous and the
 * confirmation one tap.
 */
export const BIMPAY_PHASE_NOTES = {
  merchantWalletAvailable: false,
  vendorApiAvailable: false,
  crossBorder: false,
  currencies: ['BBD'] as const,
} as const;

/**
 * The published limits on a BASIC (Tier 1) BiMPay wallet, in cents.
 *
 * Offered so a business can adopt the real numbers without typing them,
 * and kept here rather than hardcoded in a screen because they are facts
 * about the rail. A business that linked an existing bank account has
 * whatever limit its own bank set - possibly none - which is why these are
 * a starting point and never a default.
 *
 * These are limits on what can be RECEIVED. A restaurant passes the daily
 * one on a quiet Friday lunch.
 */
export const BIMPAY_BASIC_WALLET_LIMITS = {
  dailyCents: 75_000,
  monthlyCents: 250_000,
  annualCents: 3_000_000,
} as const;

export function availableMethods(): PaymentMethodCapability[] {
  return FOOD_PAYMENT_METHODS.map((key) => PAYMENT_METHOD_CAPABILITIES[key]).filter((method) => !method.notYetIntegrated);
}
