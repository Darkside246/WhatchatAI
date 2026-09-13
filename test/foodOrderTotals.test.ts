import { describe, expect, it } from 'vitest';
import { computeOrderTotals, discountFromPercent } from '../src/domain/food/orderTotals.js';

/**
 * The four numbers on a bill, and the order they are worked out in.
 *
 * These have to agree on the till, on the receipt, in the customer's chat
 * and in the books - so they are worked out in one place, and this is where
 * that place is checked. Every case here is one somebody gets wrong: taxing
 * money nobody paid, discounting the driver's fee, or adding tax on top of
 * a price that already contained it.
 */

const NO_TAX = { rateBasisPoints: null, inclusive: true };
/** Barbados VAT. */
const VAT = { rateBasisPoints: 1750, inclusive: true };

describe('an ordinary order with nothing special about it', () => {
  it('is just the food', () => {
    const totals = computeOrderTotals({
      itemsSubtotalCents: 2_000,
      deliveryFeeCents: 0,
      requestedDiscountCents: 0,
      tax: NO_TAX,
    });
    expect(totals.totalCents).toBe(2_000);
    expect(totals.taxCents).toBe(0);
  });

  it('adds the delivery fee', () => {
    const totals = computeOrderTotals({
      itemsSubtotalCents: 2_000,
      deliveryFeeCents: 500,
      requestedDiscountCents: 0,
      tax: NO_TAX,
    });
    expect(totals.totalCents).toBe(2_500);
  });

  it('shows no tax line at all for a business that has not set a rate', () => {
    // Not zero-as-a-guess: a business that has said nothing has a receipt
    // with no tax on it, exactly as it does today.
    expect(computeOrderTotals({ itemsSubtotalCents: 2_000, deliveryFeeCents: 0, requestedDiscountCents: 0, tax: NO_TAX }).taxCents).toBe(0);
  });
});

describe('taking something off', () => {
  const base = { itemsSubtotalCents: 2_000, deliveryFeeCents: 500, tax: NO_TAX };

  it('comes off the food', () => {
    expect(computeOrderTotals({ ...base, requestedDiscountCents: 300 }).totalCents).toBe(2_200);
  });

  it('does not come off the delivery - the driver still drove', () => {
    // A shop taking money off a late order is apologising for the food.
    // Discounting the whole bill quietly reduces a fee somebody else's
    // cost is attached to.
    const totals = computeOrderTotals({ ...base, requestedDiscountCents: 2_000 });
    expect(totals.deliveryFeeCents).toBe(500);
    expect(totals.totalCents).toBe(500);
  });

  it('never takes off more than the food, however much is asked for', () => {
    // A typo, or somebody trying it on. Either way the answer is a free
    // meal, not a negative bill.
    const totals = computeOrderTotals({ ...base, requestedDiscountCents: 999_999 });
    expect(totals.discountCents).toBe(2_000);
    expect(totals.totalCents).toBe(500);
  });

  it('treats a negative discount as none rather than a surcharge', () => {
    expect(computeOrderTotals({ ...base, requestedDiscountCents: -500 }).discountCents).toBe(0);
  });

  it('keeps the gross and the discount separately, so the books can show both', () => {
    // A discount folded into the line price is revenue that vanished with
    // no record of who gave it away.
    const totals = computeOrderTotals({ ...base, requestedDiscountCents: 300 });
    expect(totals.itemsSubtotalCents).toBe(2_000);
    expect(totals.discountCents).toBe(300);
  });
});

describe('tax that is already in the price', () => {
  it('does not change the total - the customer pays what is on the board', () => {
    // The mistake that overcharges every customer in the shop.
    const totals = computeOrderTotals({ itemsSubtotalCents: 2_350, deliveryFeeCents: 0, requestedDiscountCents: 0, tax: VAT });
    expect(totals.totalCents).toBe(2_350);
  });

  it('still says how much of it was tax', () => {
    // $23.50 at 17.5% inclusive: 2350 x 1750 / 11750 = 350.
    const totals = computeOrderTotals({ itemsSubtotalCents: 2_350, deliveryFeeCents: 0, requestedDiscountCents: 0, tax: VAT });
    expect(totals.taxCents).toBe(350);
  });

  it('works the tax out of what was actually paid, not what was asked for', () => {
    // Tax on money nobody handed over is wrong, and the kind of wrong a
    // tax authority notices.
    const full = computeOrderTotals({ itemsSubtotalCents: 2_350, deliveryFeeCents: 0, requestedDiscountCents: 0, tax: VAT });
    const discounted = computeOrderTotals({ itemsSubtotalCents: 2_350, deliveryFeeCents: 0, requestedDiscountCents: 1_000, tax: VAT });
    expect(discounted.taxCents).toBeLessThan(full.taxCents);
    expect(discounted.totalCents).toBe(1_350);
  });
});

describe('tax added on top', () => {
  const EXCLUSIVE = { rateBasisPoints: 1750, inclusive: false };

  it('raises the total', () => {
    const totals = computeOrderTotals({ itemsSubtotalCents: 2_000, deliveryFeeCents: 0, requestedDiscountCents: 0, tax: EXCLUSIVE });
    expect(totals.taxCents).toBe(350);
    expect(totals.totalCents).toBe(2_350);
  });

  it('is worked out after the discount', () => {
    const totals = computeOrderTotals({ itemsSubtotalCents: 2_000, deliveryFeeCents: 0, requestedDiscountCents: 1_000, tax: EXCLUSIVE });
    expect(totals.taxCents).toBe(175);
    expect(totals.totalCents).toBe(1_175);
  });

  it('taxes the delivery fee too, because it is part of what is being charged', () => {
    const totals = computeOrderTotals({ itemsSubtotalCents: 2_000, deliveryFeeCents: 500, requestedDiscountCents: 0, tax: EXCLUSIVE });
    expect(totals.totalCents).toBe(2_500 + 438);
  });
});

describe('the two readings of the same rate', () => {
  it('are genuinely different money, which is why the setting has to exist', () => {
    // Getting this backwards either overcharges every customer or
    // under-declares every return.
    const inclusive = computeOrderTotals({ itemsSubtotalCents: 2_000, deliveryFeeCents: 0, requestedDiscountCents: 0, tax: VAT });
    const exclusive = computeOrderTotals({
      itemsSubtotalCents: 2_000,
      deliveryFeeCents: 0,
      requestedDiscountCents: 0,
      tax: { rateBasisPoints: 1750, inclusive: false },
    });
    expect(inclusive.totalCents).toBe(2_000);
    expect(exclusive.totalCents).toBe(2_350);
  });
});

describe('numbers that should never arrive but do', () => {
  it('survives values that are not numbers at all', () => {
    const totals = computeOrderTotals({
      itemsSubtotalCents: Number.NaN,
      deliveryFeeCents: Number.POSITIVE_INFINITY,
      requestedDiscountCents: Number.NaN,
      tax: VAT,
    });
    expect(totals.totalCents).toBe(0);
  });

  it('refuses a negative subtotal rather than paying somebody', () => {
    expect(computeOrderTotals({ itemsSubtotalCents: -500, deliveryFeeCents: 0, requestedDiscountCents: 0, tax: NO_TAX }).totalCents).toBe(0);
  });
});

describe('typing a percentage at the till', () => {
  it('turns into the amount that gets stored', () => {
    // The amount is the truth: an order corrected afterwards makes the same
    // percentage a different number, and the one somebody agreed to with
    // the customer is the one they said out loud.
    expect(discountFromPercent(2_000, 10)).toBe(200);
  });

  it('rounds to the cent rather than carrying a fraction', () => {
    expect(discountFromPercent(1_999, 10)).toBe(200);
  });

  it('refuses more than everything, and less than nothing', () => {
    expect(discountFromPercent(2_000, 500)).toBe(2_000);
    expect(discountFromPercent(2_000, -10)).toBe(0);
  });
});
