/**
 * What an order actually comes to.
 *
 * Four numbers that have to agree with each other, on the till, on the
 * receipt, in the customer's chat and in the books - so they are worked out
 * in exactly one place and that place is here, with no database and no
 * network in sight.
 *
 * THE ORDER OF OPERATIONS, AND WHY IT IS THIS ONE.
 *
 *   items -> discount -> delivery -> tax
 *
 * The discount comes off the FOOD and not the delivery. A shop taking a
 * dollar off a late order is apologising for the food; the driver still
 * drove. Applying it to the whole bill would quietly reduce a fee that
 * somebody else's cost is attached to.
 *
 * Tax is worked out LAST, on what is actually being paid. Taxing before the
 * discount charges tax on money nobody handed over, which is both wrong and
 * the kind of wrong a tax authority notices.
 *
 * INCLUSIVE VERSUS EXCLUSIVE is the part people get wrong, so it is stated
 * plainly. With tax-inclusive prices - the default, and what every price
 * already in this system means - the total does not change at all: the tax
 * is worked BACK OUT of it, so the customer pays the number on the board
 * and the books can still show what part of it was tax. With tax-exclusive
 * prices, tax is added on top and the total goes up. Getting this backwards
 * either overcharges every customer or under-declares every return.
 *
 * All integer cents. Rounding happens once, at the end of each division,
 * with Math.round rather than truncation - over a thousand orders a floor
 * is a real amount of money in one direction.
 */

export interface OrderTotals {
  /** Food and modifiers, before anything is taken off or added on. */
  itemsSubtotalCents: number;
  /** What was taken off the food. Never more than the food itself. */
  discountCents: number;
  deliveryFeeCents: number;
  /**
   * The tax inside (inclusive) or on top of (exclusive) the total. Zero
   * when the business has not set a rate - never a guess.
   */
  taxCents: number;
  /** What the customer pays. */
  totalCents: number;
}

export interface TaxRule {
  /** 17.5% is 1750. Null means the business has not said, and no tax is shown. */
  rateBasisPoints: number | null;
  /** True when the prices on the board already contain the tax. */
  inclusive: boolean;
}

/**
 * Adds it all up.
 *
 * `requestedDiscountCents` is what somebody asked to take off; it is
 * clamped to the food, because an order cannot cost less than nothing and a
 * discount is not a refund of the delivery fee.
 */
export function computeOrderTotals(input: {
  itemsSubtotalCents: number;
  deliveryFeeCents: number;
  requestedDiscountCents: number;
  tax: TaxRule;
}): OrderTotals {
  const items = Math.max(0, Math.round(nonFinite(input.itemsSubtotalCents)));
  const delivery = Math.max(0, Math.round(nonFinite(input.deliveryFeeCents)));

  // Never more than the food. A bigger discount than the order is either a
  // typo or somebody trying it on, and in both cases the right answer is a
  // free meal rather than a negative bill.
  const discount = Math.min(items, Math.max(0, Math.round(nonFinite(input.requestedDiscountCents))));

  const payable = items - discount + delivery;
  const rate = input.tax.rateBasisPoints;

  if (rate === null || rate <= 0) {
    // No rate set. No tax line, and the total is exactly what it would have
    // been before any of this existed.
    return {
      itemsSubtotalCents: items,
      discountCents: discount,
      deliveryFeeCents: delivery,
      taxCents: 0,
      totalCents: payable,
    };
  }

  if (input.tax.inclusive) {
    /* The tax is already in there. Worked back out - total x rate /
       (10000 + rate) - so the customer pays the price on the board and the
       return can still show the tax inside it. The total does NOT move. */
    return {
      itemsSubtotalCents: items,
      discountCents: discount,
      deliveryFeeCents: delivery,
      taxCents: Math.round((payable * rate) / (10_000 + rate)),
      totalCents: payable,
    };
  }

  const tax = Math.round((payable * rate) / 10_000);
  return {
    itemsSubtotalCents: items,
    discountCents: discount,
    deliveryFeeCents: delivery,
    taxCents: tax,
    totalCents: payable + tax,
  };
}

/**
 * Turns a percentage typed at the till into the amount that gets stored.
 *
 * The amount is the truth, not the percent: an order corrected afterwards
 * makes the same percentage a different number, and the one somebody agreed
 * to with the customer is the number they said out loud. So the percent is
 * a way of TYPING an amount and is not kept.
 */
export function discountFromPercent(itemsSubtotalCents: number, percent: number): number {
  const subtotal = Math.max(0, Math.round(nonFinite(itemsSubtotalCents)));
  const share = Math.min(100, Math.max(0, nonFinite(percent)));
  return Math.round((subtotal * share) / 100);
}

/** NaN and Infinity arrive from parsed input often enough to be worth refusing once, here. */
function nonFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
