import { ALIAS_KIND_LABEL, PAYMENT_METHOD_CAPABILITIES, type FoodPaymentMethodKey, type PaymentAliasKind } from '../../domain/food/paymentMethods.js';
import type { FoodOrderRecord } from '../../repositories/foodOperationsRepository.js';

/**
 * Asking a customer to pay.
 *
 * The part of "send a BiMPay request and process the order when it
 * confirms" that can honestly be automated. AURA cannot create the
 * request-to-pay - that happens in a bank's own app, by a person - but it
 * can do everything around it: tell the customer the exact amount, the
 * alias to send it to, and the order number to put as the reference, then
 * hold the order out of the kitchen until somebody confirms the money
 * arrived.
 *
 * The reference matters more than it looks. A business reconciling six
 * transfers at closing time can only match them to orders if each carries
 * the order number, and the only moment anybody will type it is when they
 * are told to.
 */

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-BB', { style: 'currency', currency }).format(cents / 100);
}

export interface PaymentAsk {
  /** What to send the customer. Null when this method has nothing to say to them. */
  message: string | null;
  /** Why there is nothing to send, for the operator rather than the customer. */
  reason: string | null;
}

/**
 * The message a customer gets.
 *
 * Written the way somebody behind a counter would say it: the amount, where
 * to send it, what to put as the reference, and what happens next. No
 * "kindly be advised", no exclamation marks.
 */
export function buildPaymentAsk(
  order: FoodOrderRecord,
  method: FoodPaymentMethodKey,
  options: { alias?: string | null; aliasKind?: PaymentAliasKind | null; instructions?: string | null } = {},
): PaymentAsk {
  const capability = PAYMENT_METHOD_CAPABILITIES[method];

  if (capability.notYetIntegrated) {
    return { message: null, reason: `${capability.label} is not connected yet.` };
  }

  // Cash at the counter needs no message. Sending one would be a business
  // texting somebody standing in front of them.
  if (method === 'CASH' || method === 'CARD_IN_PERSON') {
    return { message: null, reason: `${capability.label} is settled in person, so there is nothing to send.` };
  }

  if (method === 'ON_ACCOUNT') {
    return { message: null, reason: 'This customer settles later, so no payment is being asked for.' };
  }

  if (capability.needsAlias && !options.alias?.trim()) {
    return {
      message: null,
      // Named precisely, so the fix is obvious without opening a settings
      // page to hunt for the missing field. The label keeps its own
      // capitalisation - lowercasing it turned "BiMPay" into "bimpay",
      // which reads as a typo in a message an owner is meant to trust.
      reason: `${capability.label} needs ${capability.aliasLabel ?? 'an alias'} before a customer can be asked to pay.`,
    };
  }

  const amount = formatMoney(order.totalCents, order.currency);
  const reference = `#${order.orderNumber}`;

  // The business's own wording wins outright when they have written some -
  // they know their customers, and a merge of their sentence and ours would
  // read like neither.
  if (options.instructions?.trim()) {
    const rendered = options.instructions
      .replaceAll('{{total}}', amount)
      .replaceAll('{{order_number}}', String(order.orderNumber))
      .replaceAll('{{alias}}', options.alias?.trim() ?? '')
      .replaceAll('{{name}}', order.customerName?.trim() ?? '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    return { message: rendered.length > 0 ? rendered : null, reason: rendered.length > 0 ? null : 'Your wording came out empty.' };
  }

  const alias = options.alias!.trim();

  /**
   * Naming the KIND of alias, not just the value.
   *
   * "Send it to 2460000000" leaves a customer guessing whether that is a
   * phone number or an account, and a payment sent to the wrong kind of
   * identifier on an irrevocable rail cannot be pulled back. So the
   * sentence says which it is whenever the business has told us.
   */
  const addressed = options.aliasKind ? `${ALIAS_KIND_LABEL[options.aliasKind]} ${alias}` : alias;

  const lines: string[] =
    method === 'BIMPAY'
      ? [
          `That comes to ${amount}.`,
          `You can send it on BiMPay to ${addressed} — put ${reference} as the reference so we can match it.`,
          // BiMPay shows the sender our name before they confirm, and this
          // is the only moment a mistyped alias can still be caught: once
          // sent, the money is with whoever owns that identifier and they
          // do not have to give it back.
          'It will show you our name before you confirm — check it matches.',
          'We start cooking as soon as it comes through.',
        ]
      : method === 'ONE_STPAY'
        ? [
            `That comes to ${amount}.`,
            `You can send it by 1stPay to ${addressed} — put ${reference} as the reference.`,
            'We start cooking as soon as it comes through.',
          ]
        : method === 'BANK_TRANSFER'
          ? [
              `That comes to ${amount}.`,
              `Transfer to ${addressed}, with ${reference} as the reference.`,
              'We start cooking once it clears.',
            ]
          : [`That comes to ${amount}. Reference ${reference}.`];

  return { message: lines.join('\n'), reason: null };
}

/**
 * What the operator is told about confirming.
 *
 * Spelled out because the honest answer is "you will know before we do",
 * and an operator who expects the screen to update by itself will leave
 * orders sitting behind the gate waiting for something that is not coming.
 */
export function confirmationGuidance(method: FoodPaymentMethodKey): string {
  const capability = PAYMENT_METHOD_CAPABILITIES[method];
  switch (capability.confirmation) {
    case 'MANUAL':
      return `BiMPay and bank transfers land in your app, not ours — when you see it, tap Payment received and the order goes to the kitchen.`;
    case 'RETURN_REDIRECT':
      return 'The customer comes back to us after paying, which we treat as needing a quick check rather than confirmed.';
    case 'SERVER_CALLBACK':
      return 'The provider tells us directly, so the order moves on its own.';
  }
}
