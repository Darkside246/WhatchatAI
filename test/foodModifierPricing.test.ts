import { describe, expect, it } from 'vitest';
import { describeModifierPrice, modifierCharge } from '../src/domain/food/modifierPricing.js';

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

describe('what a condiment costs', () => {
  it('charges every one when none are included - the ordinary paid add-on, unchanged', () => {
    expect(modifierCharge(3, 0, 150)).toMatchObject({ chargedQuantity: 3, totalCents: 450 });
  });

  it('gives the included one away and charges the rest', () => {
    expect(modifierCharge(3, 1, 150)).toMatchObject({ freeQuantity: 1, chargedQuantity: 2, totalCents: 300 });
  });

  it('charges nothing when they take only what the dish includes', () => {
    expect(modifierCharge(1, 1, 150)).toMatchObject({ chargedQuantity: 0, totalCents: 0 });
  });

  it('honours an allowance of more than one', () => {
    expect(modifierCharge(3, 2, 150)).toMatchObject({ freeQuantity: 2, chargedQuantity: 1, totalCents: 150 });
  });

  it('does not turn an unused allowance into a credit', () => {
    // Two sauces included, one taken. The other is not banked against the bill.
    const charge = modifierCharge(1, 2, 150);
    expect(charge.freeQuantity).toBe(1);
    expect(charge.totalCents).toBe(0);
  });

  it('costs nothing when nothing was asked for', () => {
    expect(modifierCharge(0, 1, 150)).toMatchObject({ chargedQuantity: 0, totalCents: 0 });
  });

  it('stays free when it is free and always free', () => {
    expect(modifierCharge(5, 0, 0).totalCents).toBe(0);
  });

  describe('numbers that should never arrive but do', () => {
    it('treats a negative quantity as none, never as a refund', () => {
      expect(modifierCharge(-2, 0, 150).totalCents).toBe(0);
    });

    it('floors a negative price rather than reducing the bill', () => {
      // A minus sign typed into a menu field must not become a discount
      // nobody authorised.
      expect(modifierCharge(2, 0, -500).totalCents).toBe(0);
    });

    it('ignores a fractional quantity rather than charging a fraction of a cent', () => {
      expect(modifierCharge(2.7, 0, 150).totalCents).toBe(300);
    });

    it('survives a value that is not a number at all', () => {
      expect(modifierCharge(Number.NaN, Number.NaN, Number.NaN).totalCents).toBe(0);
    });
  });
});

describe('describing the price in one sentence', () => {
  it('says free when it is free', () => {
    expect(describeModifierPrice(0, 0, money)).toBe('free');
  });

  it('gives the price when every one is charged', () => {
    expect(describeModifierPrice(0, 150, money)).toBe('$1.50 each');
  });

  it('says the first is free and what the next costs', () => {
    expect(describeModifierPrice(1, 150, money)).toBe('first one free, then $1.50 each');
  });

  it('counts the allowance when it is more than one', () => {
    expect(describeModifierPrice(2, 150, money)).toBe('2 free, then $1.50 each');
  });

  it('does not claim extras cost anything when no price was set for them', () => {
    // Free with no price for extras is unlimited. Saying "extras cost" would
    // be a claim the menu cannot back, and the agent would repeat it.
    expect(describeModifierPrice(1, 0, money)).toBe('free');
  });
});
