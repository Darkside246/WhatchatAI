import type { FoodOrderRecord, FoodSettingsRecord } from '../../repositories/foodOperationsRepository.js';

/**
 * Telling the customer that the kitchen waits for payment.
 *
 * A commercial policy has to be said out loud at the moment it applies.
 * An order that sits untouched while the customer assumes it is cooking is
 * how a business loses somebody - they are not annoyed that payment is
 * required, they are annoyed that nobody mentioned it.
 *
 * WHEN IT MUST NOT BE SENT is as much the feature as when it must:
 *
 * - to a customer on standing pay-on-delivery terms, who would be told a
 *   rule that does not apply to them and would reasonably reply asking
 *   what payment;
 * - by a business that does not gate on payment at all;
 * - for an order already paid, where it reads as a demand for money
 *   somebody has just handed over.
 *
 * Each of those is a real message to a real customer that should never
 * leave, which is why this returns null rather than a string a caller
 * might send anyway.
 */

export const DEFAULT_PAYMENT_REQUIRED_NOTICE =
  'Thanks {{name}} — your order is saved as #{{order_number}}, total {{total}}. ' +
  'We start cooking once the payment comes through, so send it across when you are ready and we will confirm the moment it lands.';

export const PAYMENT_NOTICE_MERGE_FIELDS = [
  { token: '{{name}}', description: "The customer's name, or nothing when it is not known" },
  { token: '{{order_number}}', description: "The order's own number, as read out over the pass" },
  { token: '{{total}}', description: 'The amount owed, formatted in the order currency' },
] as const;

function formatMoney(cents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
  } catch {
    // An unrecognised currency code must not cost the customer their
    // message - the number is the part that matters.
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/**
 * The notice for this order, or null when it must not be sent.
 *
 * A missing name is tidied away rather than left as a gap: "Thanks  —
 * your order is saved" reads as a bug to the person receiving it.
 */
export function paymentRequiredNotice(order: FoodOrderRecord, settings: FoodSettingsRecord): string | null {
  if (!settings.paymentRequiredBeforeKitchen) return null;

  // WAIVED covers both standing terms and a manual release. Either way
  // this customer is not being asked for money up front.
  if (order.paymentState !== 'UNPAID') return null;

  const template = settings.paymentRequiredNotice?.trim() || DEFAULT_PAYMENT_REQUIRED_NOTICE;
  const name = order.customerName?.trim() ?? '';

  return template
    .replaceAll('{{name}}', name)
    .replaceAll('{{order_number}}', String(order.orderNumber))
    .replaceAll('{{total}}', formatMoney(order.totalCents, order.currency))
    .replace(/\s{2,}/g, ' ')
    // Only before a comma or a full stop. An em dash keeps its space -
    // stripping it produced "Thanks— your order is saved", which reads
    // worse than the gap it was meant to fix.
    .replace(/\s+([,.])/g, '$1')
    .trim();
}
