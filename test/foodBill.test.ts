import { describe, expect, it } from 'vitest';
import { buildCustomerBill, type BillInput } from '../src/domain/food/foodBill.js';

/**
 * The bill a customer reads on their phone.
 *
 * Somebody who ordered over chat has no receipt, no screen and no counter.
 * All they have is the conversation, so the bill has to BE a message. These
 * pin the two things that make it trustworthy: every figure on it is one
 * the server worked out, and nothing on it claims money has arrived.
 */

const base: BillInput = {
  orderNumber: 41,
  lines: [
    { name: 'Fish cutter', quantity: 2, unitPriceCents: 1_200, modifiersPerUnitCents: 0, modifiers: [] },
  ],
  subtotalCents: 2_400,
  discountCents: 0,
  deliveryFeeCents: 0,
  taxCents: 0,
  totalCents: 2_400,
  currency: 'BBD',
  taxInclusive: true,
  payTo: null,
  paymentRequired: true,
};

describe('an ordinary bill', () => {
  it('names the order so somebody can quote it back', () => {
    expect(buildCustomerBill(base)).toContain('Order #41');
  });

  it('itemises what they actually ordered', () => {
    expect(buildCustomerBill(base)).toContain('2 x Fish cutter');
  });

  it('multiplies out, rather than making the customer do it', () => {
    expect(buildCustomerBill(base)).toContain('BBD 24.00');
  });

  it('ends on the total', () => {
    const lines = buildCustomerBill(base).split('\n').filter((line) => line.includes('Total'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('BBD 24.00');
  });

  it('does not print a subtotal when nothing comes after it', () => {
    // A subtotal identical to the total, one line above it, is noise that
    // makes somebody check whether they have been charged twice.
    expect(buildCustomerBill(base)).not.toContain('Subtotal');
  });
});

describe('what the customer asked to change', () => {
  it('shows a removal, which is the thing most often got wrong', () => {
    const bill = buildCustomerBill({
      ...base,
      lines: [{ ...base.lines[0]!, modifiers: [{ name: 'onions', action: 'remove' }] }],
    });
    expect(bill).toContain('no onions');
  });

  it('counts an extra they asked for more than one of', () => {
    const bill = buildCustomerBill({
      ...base,
      lines: [{ ...base.lines[0]!, modifiersPerUnitCents: 150, modifiers: [{ name: 'pepper sauce', action: 'add', quantity: 2 }] }],
    });
    expect(bill).toContain('2 x pepper sauce');
  });

  it('prices the modifiers into the line rather than listing them as money', () => {
    // The customer wants to know what the dish came to, not to reconcile a
    // column of fifty-cent adjustments.
    const bill = buildCustomerBill({
      ...base,
      lines: [{ ...base.lines[0]!, modifiersPerUnitCents: 150, modifiers: [{ name: 'pepper sauce', action: 'add' }] }],
      subtotalCents: 2_700,
      totalCents: 2_700,
    });
    expect(bill).toContain('BBD 27.00');
  });
});

describe('the lines that only appear when they are real', () => {
  it('shows a discount when one was given', () => {
    const bill = buildCustomerBill({ ...base, discountCents: 400, totalCents: 2_000 });
    expect(bill).toContain('Discount  -BBD 4.00');
    expect(bill).toContain('Subtotal');
  });

  it('shows delivery when there is any', () => {
    expect(buildCustomerBill({ ...base, deliveryFeeCents: 500, totalCents: 2_900 })).toContain('Delivery  BBD 5.00');
  });

  it('says tax is INSIDE the total when prices include it', () => {
    // The two readings mean opposite things to somebody adding up the
    // column, and getting it backwards makes the page look wrong.
    const bill = buildCustomerBill({ ...base, taxCents: 357 });
    expect(bill).toContain('(includes BBD 3.57 tax)');
  });

  it('adds tax as its own row when prices exclude it', () => {
    const bill = buildCustomerBill({ ...base, taxInclusive: false, taxCents: 420, totalCents: 2_820 });
    expect(bill).toContain('Tax  BBD 4.20');
    expect(bill).not.toContain('includes');
  });

  it('prints no tax line at all for a business that charges none', () => {
    // A tax line on a business with no registration is a claim that is not
    // ours to make on their behalf.
    expect(buildCustomerBill(base)).not.toMatch(/tax/i);
  });

  it('prints no discount line when none was given', () => {
    expect(buildCustomerBill(base)).not.toContain('Discount');
  });
});

describe('how to pay', () => {
  it('uses the business own words, verbatim', () => {
    const bill = buildCustomerBill({ ...base, payTo: 'Send to 246-555-0100 on mMoney and put the order number in the note.' });
    expect(bill).toContain('Send to 246-555-0100 on mMoney and put the order number in the note.');
  });

  it('says nothing about paying when the business has set nothing', () => {
    // It never invents a method. A made-up way to pay is money sent
    // somewhere nobody is watching.
    const bill = buildCustomerBill(base);
    expect(bill).not.toMatch(/bank|transfer|cash app|paypal/i);
  });
});

describe('what it must never say', () => {
  it('never claims the money has arrived', () => {
    // That claim belongs to the payment record and nothing else. A message
    // that says "paid" because somebody pressed send is how a business
    // gives away an order.
    const bill = buildCustomerBill({ ...base, payTo: 'Pay on collection.' });
    expect(bill).not.toMatch(/\b(paid|received|settled|confirmed)\b/i);
  });

  it('tells somebody why nothing is happening yet, where the kitchen waits', () => {
    expect(buildCustomerBill(base)).toContain('as soon as the payment comes through');
  });

  it('does not promise that paying starts anything, where the kitchen does not wait', () => {
    const bill = buildCustomerBill({ ...base, paymentRequired: false });
    expect(bill).not.toContain('as soon as the payment comes through');
  });
});
