/**
 * What a condiment actually costs.
 *
 * A real kitchen offers the same thing two ways at once: the ketchup that
 * comes with the chips, and the third pot of it that does not. Before this
 * an option had one price and one meaning - every one charged, or every one
 * free - so "comes with it, pay for extra" could not be said at all, and
 * the extra either went out unpaid or the included one was charged for.
 *
 * So an option carries how many come free, and everything past that is
 * charged. Zero free is the ordinary paid add-on, unchanged. One free is
 * the common case. More than one is a real thing too: two sauces with a
 * large, a third costs.
 *
 * Kept here, away from the intake pipeline, because this is arithmetic
 * about somebody's money and it must be checkable on its own rather than
 * only observable through an order.
 */

export interface ModifierCharge {
  /** How many were asked for. */
  quantity: number;
  /** How many of those were free. Never more than were asked for. */
  freeQuantity: number;
  /** How many are being charged for. */
  chargedQuantity: number;
  /** What the whole modifier adds to the line. */
  totalCents: number;
}

/**
 * Prices one modifier on one line.
 *
 * `quantity` is how many the customer asked for; `freeQuantity` is how many
 * the dish includes at no charge; `priceDeltaCents` is what one costs once
 * the free ones are used up.
 *
 * Everything is clamped rather than trusted. These numbers arrive from a
 * menu an operator typed, an order an agent parsed, and a basket a browser
 * sent - a negative quantity or a free count larger than the order should
 * produce a sane charge, not a refund.
 */
export function modifierCharge(
  quantity: number,
  freeQuantity: number,
  priceDeltaCents: number,
): ModifierCharge {
  const asked = Math.max(0, Math.trunc(Number.isFinite(quantity) ? quantity : 0));
  const freeAllowance = Math.max(0, Math.trunc(Number.isFinite(freeQuantity) ? freeQuantity : 0));
  const unit = Number.isFinite(priceDeltaCents) ? Math.trunc(priceDeltaCents) : 0;

  // More free than asked for is not a credit. A dish that includes two
  // sauces and a customer who wants one has used one allowance, not banked
  // the other against the bill.
  const free = Math.min(asked, freeAllowance);
  const charged = asked - free;

  return {
    quantity: asked,
    freeQuantity: free,
    chargedQuantity: charged,
    // A negative unit price would be a discount nobody entered deliberately;
    // it is floored at zero so a typo in the menu cannot reduce a bill.
    totalCents: charged * Math.max(0, unit),
  };
}

/**
 * How to describe the option on a menu, to a customer, and to the agent.
 *
 * One sentence, in the words a customer would use, so the agent is never
 * left inventing its own phrasing for the business's pricing - and so the
 * menu screen and the chat say the same thing.
 */
export function describeModifierPrice(
  freeQuantity: number,
  priceDeltaCents: number,
  formatMoney: (cents: number) => string,
): string {
  const free = Math.max(0, Math.trunc(freeQuantity));
  const unit = Math.max(0, Math.trunc(priceDeltaCents));

  if (free === 0) return unit === 0 ? 'free' : `${formatMoney(unit)} each`;
  // Free with no price for extras means unlimited: there is nothing to
  // charge, so saying "extras cost" would be a claim we cannot back.
  if (unit === 0) return 'free';

  const included = free === 1 ? 'first one free' : `${free} free`;
  return `${included}, then ${formatMoney(unit)} each`;
}
