import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * The history behind the board.
 *
 * A finished ticket leaves the board, which is right - but the questions
 * that come afterwards are real, and until now there was no way to answer
 * any of them: what was in order 412, what did this customer order last
 * time, did we actually send the thing they say we did not.
 */
describe('order history', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
    await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, null);
  });

  async function closedOrder(
    overrides: Partial<Parameters<FoodOperationsRepository['createOrder']>[0]> = {},
    stage: 'COMPLETED' | 'CANCELLED' = 'COMPLETED',
  ) {
    const order = await repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [{ menuItemId: null, name: 'Chicken roti', variant: null, quantity: 1, unitPriceCents: 1200, modifiers: [], notes: null }],
      subtotalCents: 1200,
      totalCents: 1200,
      ...overrides,
    });
    // Straight to closed: this is about the archive, not about the lifecycle
    // guard, which foodOrderLifecycle covers.
    await pool.query('UPDATE food_orders SET stage = $2, closed_at = now() WHERE id = $1', [order.id, stage]);
    return order;
  }

  it('returns only orders that are finished with', async () => {
    const done = await closedOrder();
    const cancelled = await closedOrder({}, 'CANCELLED');
    // Still on the board, so not history.
    const live = await repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [],
      subtotalCents: 0,
      totalCents: 0,
    });

    const ids = (await repo.listHistory(businessId)).orders.map((order) => order.id);
    expect(ids).toContain(done.id);
    expect(ids).toContain(cancelled.id);
    expect(ids).not.toContain(live.id);
  });

  it('puts the most recently closed first', async () => {
    const first = await closedOrder();
    await pool.query("UPDATE food_orders SET closed_at = now() - interval '2 hours' WHERE id = $1", [first.id]);
    const second = await closedOrder();

    expect((await repo.listHistory(businessId)).orders.map((order) => order.id)).toEqual([second.id, first.id]);
  });

  it('finds an order by its number, exactly', async () => {
    const first = await closedOrder();
    await closedOrder();

    const found = await repo.listHistory(businessId, { query: String(first.orderNumber) });
    expect(found.orders.map((order) => order.id)).toEqual([first.id]);
    // The hash is how an operator writes it down and how it is printed.
    expect((await repo.listHistory(businessId, { query: `#${first.orderNumber}` })).orders.map((o) => o.id)).toEqual([first.id]);
  });

  it('does not match a number against anything but the order number', async () => {
    // "1200" is this order's price in cents. Searching a number must not
    // start dredging up every order whose totals happen to contain it.
    await closedOrder();
    expect((await repo.listHistory(businessId, { query: '1200' })).orders).toEqual([]);
  });

  it('finds an order by who it was for', async () => {
    const hers = await closedOrder({ customerName: 'Marcia Alleyne', customerPhone: '2465550101' });
    await closedOrder({ customerName: 'Someone Else' });

    expect((await repo.listHistory(businessId, { query: 'marcia' })).orders.map((o) => o.id)).toEqual([hers.id]);
    expect((await repo.listHistory(businessId, { query: '5550101' })).orders.map((o) => o.id)).toEqual([hers.id]);
  });

  it('finds an order by what was in it', async () => {
    // The question an owner actually asks most - "which orders had the lamb
    // roti" - and the one that needs the items JSONB to be searched.
    const lamb = await closedOrder({
      items: [{ menuItemId: null, name: 'Lamb roti', variant: null, quantity: 1, unitPriceCents: 1600, modifiers: [], notes: null }],
    });
    await closedOrder();

    expect((await repo.listHistory(businessId, { query: 'lamb' })).orders.map((o) => o.id)).toEqual([lamb.id]);
  });

  it('pages without skipping a row when another order closes mid-listing', async () => {
    // The reason this is a keyset and not an OFFSET: with OFFSET, an order
    // closing between page one and page two shifts every later row up and
    // one is silently never shown.
    // Closed at known, distinct times so the expected order is not a guess.
    const created = [];
    for (let index = 0; index < 5; index += 1) {
      const order = await closedOrder();
      await pool.query(`UPDATE food_orders SET closed_at = now() - interval '${5 - index} hours' WHERE id = $1`, [order.id]);
      created.push(order);
    }
    // created[4] is the most recent, created[0] the oldest.
    const newestFirst = [...created].reverse().map((order) => order.id);

    const first = await repo.listHistory(businessId, { limit: 2 });
    expect(first.orders.map((order) => order.id)).toEqual(newestFirst.slice(0, 2));
    expect(first.nextCursor).not.toBeNull();

    // A brand new closure arrives at the TOP of the ordering, which is
    // exactly what breaks an offset-based second page: OFFSET 2 would now
    // step over the row that had just moved down into that position.
    await closedOrder();

    const second = await repo.listHistory(businessId, { limit: 2, before: first.nextCursor! });
    expect(second.orders.map((order) => order.id)).toEqual(newestFirst.slice(2, 4));
  });

  it('stops offering a cursor on the last page', async () => {
    await closedOrder();
    await closedOrder();

    expect((await repo.listHistory(businessId, { limit: 25 })).nextCursor).toBeNull();
  });

  it("never returns another business's orders", async () => {
    const other = await createTestBusiness('Someone Else');
    await repo.saveSettings(other, { paymentRequiredBeforeKitchen: false }, null);
    const theirs = await repo.createOrder({
      businessId: other,
      fulfilmentMethod: 'PICKUP',
      items: [],
      subtotalCents: 0,
      totalCents: 0,
      customerName: 'Marcia Alleyne',
    });
    await pool.query("UPDATE food_orders SET stage = 'COMPLETED', closed_at = now() WHERE id = $1", [theirs.id]);

    expect((await repo.listHistory(businessId)).orders).toEqual([]);
    expect((await repo.listHistory(businessId, { query: 'marcia' })).orders).toEqual([]);
  });
});
