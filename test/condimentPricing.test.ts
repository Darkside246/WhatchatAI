import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { resolveProposal } from '../src/services/food/orderIntake.js';
import { basketLineKey } from '../src/web/src/lib/basket.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * "Free with the dish, pay for the extra" - on a real order.
 *
 * modifierPricing.ts has been able to do this arithmetic, with its own
 * tests, since migration 1045. Nothing used it: orderIntake summed
 * priceDeltaCents directly, so an owner could not set an allowance, a
 * cashier could not ring one, and the price would have been wrong if they
 * could. These are about the ORDER, not the arithmetic - the half that was
 * missing.
 *
 * The invariant that protects every existing menu: with no allowance set,
 * every total here must be exactly what it was before any of this existed.
 */

const SAUCE = 150;

describe('pricing an order with condiments', () => {
  let businessId: string;
  let repository: FoodOperationsRepository;
  let groupId: string;

  /** A dish at $10 with one modifier group attached. */
  async function menuWith(freeQuantity: number) {
    const item = await repository.createMenuItem({
      businessId,
      name: 'Chicken and chips',
      priceCents: 1_000,
      currency: 'BBD',
    });
    const group = await repository.createModifierGroup(businessId, { name: 'Sauces', minSelect: 0, maxSelect: null });
    groupId = group.id;
    await repository.addModifierOption(businessId, group.id, { name: 'Pepper sauce', priceDeltaCents: SAUCE, freeQuantity });
    await repository.attachModifierGroup(businessId, item.id, group.id);
    return item;
  }

  async function quote(quantity: number, modifierQuantity: number) {
    const result = await resolveProposal(repository, businessId, {
      fulfilmentMethod: 'PICKUP',
      lines: [
        {
          reference: 'Chicken and chips',
          quantity,
          modifiers: [{ name: 'Pepper sauce', action: 'add', quantity: modifierQuantity }],
        },
      ],
    });
    if (!result.ok) throw new Error(`not priced: ${JSON.stringify(result.problems)}`);
    return result.resolved;
  }

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    repository = new FoodOperationsRepository(pool);
  });

  it('charges nothing for the sauce that comes with it', async () => {
    await menuWith(1);
    expect((await quote(1, 1)).subtotalCents).toBe(1_000);
  });

  it('charges for the second one', async () => {
    await menuWith(1);
    expect((await quote(1, 2)).subtotalCents).toBe(1_000 + SAUCE);
  });

  it('honours an allowance of two', async () => {
    await menuWith(2);
    expect((await quote(1, 3)).subtotalCents).toBe(1_000 + SAUCE);
  });

  it('charges every one when nothing is included - every menu written before this', async () => {
    // The invariant. A menu with no allowance must price exactly as it did
    // when orderIntake summed priceDeltaCents directly.
    await menuWith(0);
    expect((await quote(1, 1)).subtotalCents).toBe(1_000 + SAUCE);
    expect((await quote(1, 3)).subtotalCents).toBe(1_000 + SAUCE * 3);
  });

  it('applies the allowance to each dish, not once across the order', async () => {
    // Two dinners, each with its own included sauce and its own paid
    // extra. A kitchen means "one with the dish", not "one per bill".
    await menuWith(1);
    expect((await quote(2, 2)).subtotalCents).toBe(2 * (1_000 + SAUCE));
  });

  it('treats an unstated quantity as one', async () => {
    await menuWith(0);
    const result = await resolveProposal(repository, businessId, {
      fulfilmentMethod: 'PICKUP',
      lines: [{ reference: 'Chicken and chips', quantity: 1, modifiers: [{ name: 'Pepper sauce', action: 'add' }] }],
    });
    if (!result.ok) throw new Error('not priced');
    expect(result.resolved.subtotalCents).toBe(1_000 + SAUCE);
  });

  it('never charges for taking something off, however many times it is asked', async () => {
    await menuWith(0);
    const result = await resolveProposal(repository, businessId, {
      fulfilmentMethod: 'PICKUP',
      lines: [{ reference: 'Chicken and chips', quantity: 1, modifiers: [{ name: 'Pepper sauce', action: 'remove', quantity: 5 }] }],
    });
    if (!result.ok) throw new Error('not priced');
    expect(result.resolved.subtotalCents).toBe(1_000);
  });

  it('carries the allowance onto the line, so the ticket and the books can see it', async () => {
    await menuWith(1);
    const [line] = (await quote(1, 2)).lines;
    expect(line?.modifiers[0]).toMatchObject({ name: 'Pepper sauce', quantity: 2, freeQuantity: 1, priceDeltaCents: SAUCE });
  });

  it('reads the allowance from the catalogue at pricing time, not from the request', async () => {
    // The rule the whole resolver exists for: an owner changing the menu
    // mid-conversation changes the price, and nothing a caller sends can.
    await menuWith(0);
    expect((await quote(1, 2)).subtotalCents).toBe(1_000 + SAUCE * 2);

    const groups = await repository.listModifierGroups(businessId);
    const option = groups.find((group) => group.id === groupId)?.options[0];
    await repository.updateModifierOption(businessId, option!.id, { freeQuantity: 2 });

    expect((await quote(1, 2)).subtotalCents).toBe(1_000);
  });
});

describe('what counts as the same line on the till', () => {
  it('keeps one sauce and three sauces apart', async () => {
    // Without this, adding a burger with one sauce and then a burger with
    // three increments the first line, and the second customer gets one
    // sauce. The customer finds out, not the shop.
    const one = basketLineKey('item', [{ name: 'Pepper sauce', action: 'add', quantity: 1 }]);
    const three = basketLineKey('item', [{ name: 'Pepper sauce', action: 'add', quantity: 3 }]);
    expect(one).not.toBe(three);
  });

  it('treats an unstated quantity and an explicit one as the same line', async () => {
    // Every basket built before quantities existed has to keep working.
    const implicit = basketLineKey('item', [{ name: 'Pepper sauce', action: 'add' }]);
    const explicit = basketLineKey('item', [{ name: 'Pepper sauce', action: 'add', quantity: 1 }]);
    expect(implicit).toBe(explicit);
  });

  it('still ignores the order they were tapped in', async () => {
    const cheeseFirst = basketLineKey('item', [
      { name: 'Cheese', action: 'add', quantity: 2 },
      { name: 'Bacon', action: 'add', quantity: 1 },
    ]);
    const baconFirst = basketLineKey('item', [
      { name: 'Bacon', action: 'add', quantity: 1 },
      { name: 'Cheese', action: 'add', quantity: 2 },
    ]);
    expect(cheeseFirst).toBe(baconFirst);
  });
});

/**
 * A price typed at the till for something the menu does not sell.
 *
 * The rule the whole resolver exists for is that a CONVERSATION cannot set
 * a price, and it is enforced structurally: the agent's tool schema has no
 * field for one. A person at a till is a different actor, and these pin
 * that letting them type an amount does not open a door back into the
 * catalogue.
 */
describe('a custom amount rung at the counter', () => {
  let businessId: string;
  let repository: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness();
    repository = new FoodOperationsRepository(pool);
    await repository.createMenuItem({ businessId, name: 'Chicken and chips', priceCents: 1_000, currency: 'BBD' });
  });

  async function ring(line: { reference: string; quantity: number; customAmountCents?: number }) {
    const result = await resolveProposal(repository, businessId, { fulfilmentMethod: 'PICKUP', lines: [line] });
    if (!result.ok) throw new Error(`not priced: ${JSON.stringify(result.problems)}`);
    return result.resolved;
  }

  it('charges what was typed', async () => {
    expect((await ring({ reference: 'Carrier bag', quantity: 1, customAmountCents: 50 })).subtotalCents).toBe(50);
  });

  it('multiplies by however many', async () => {
    expect((await ring({ reference: 'Extra cup', quantity: 3, customAmountCents: 75 })).subtotalCents).toBe(225);
  });

  it('keeps the name typed on it, so the books say what was sold', async () => {
    const [line] = (await ring({ reference: 'Carrier bag', quantity: 1, customAmountCents: 50 })).lines;
    expect(line?.name).toBe('Carrier bag');
  });

  it('is not a menu item, and never claims to be', async () => {
    // The two paths do not meet: a custom line has no catalogue row, so it
    // cannot be used to make a real dish cost something else.
    const [line] = (await ring({ reference: 'Carrier bag', quantity: 1, customAmountCents: 50 })).lines;
    expect(line?.menuItemId).toBeNull();
  });

  it('does not become a real dish just because it shares its name', async () => {
    // Typing "Chicken and chips" with an amount must not reprice the menu
    // item - it rings a separate, hand-keyed line at the typed amount.
    const resolved = await ring({ reference: 'Chicken and chips', quantity: 1, customAmountCents: 1 });
    expect(resolved.subtotalCents).toBe(1);
    expect(resolved.lines[0]?.menuItemId).toBeNull();
  });

  it('refuses a negative amount rather than paying the customer', async () => {
    expect((await ring({ reference: 'Oops', quantity: 1, customAmountCents: -5_000 })).subtotalCents).toBe(0);
  });

  it('names an unnamed line rather than ringing a blank', async () => {
    const [line] = (await ring({ reference: '   ', quantity: 1, customAmountCents: 100 })).lines;
    expect(line?.name).toBe('Custom amount');
  });

  it('leaves an ordinary line alone', async () => {
    // The invariant: a line with no custom amount is matched and priced
    // against the catalogue exactly as it always was.
    const resolved = await ring({ reference: 'Chicken and chips', quantity: 2 });
    expect(resolved.subtotalCents).toBe(2_000);
    expect(resolved.lines[0]?.menuItemId).not.toBeNull();
  });
});
