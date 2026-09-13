import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

/**
 * The closing-time numbers.
 *
 * The query behind this carries several judgements that are invisible on the
 * screen and expensive to get wrong: what counts as money, what counts as
 * late, and which orders belong to the day at all. These pin them.
 */
describe('service summary', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;
  /** A wide window, so these tests are about the filters and not about clock arithmetic (foodServiceDay covers that). */
  const window = { from: new Date(Date.now() - 86_400_000), to: new Date(Date.now() + 86_400_000) };

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
    await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, null);
  });

  async function anOrder(totalCents: number, overrides: Record<string, unknown> = {}) {
    return repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [{ menuItemId: null, name: 'Roti', variant: null, quantity: 1, unitPriceCents: totalCents, modifiers: [], notes: null }],
      subtotalCents: totalCents,
      totalCents,
      ...overrides,
    });
  }

  it('counts what was taken, finished and cancelled', async () => {
    const done = await anOrder(1000);
    const gone = await anOrder(1000);
    await anOrder(1000);
    await pool.query("UPDATE food_orders SET stage = 'COMPLETED', closed_at = now() WHERE id = $1", [done.id]);
    await pool.query("UPDATE food_orders SET stage = 'CANCELLED', closed_at = now() WHERE id = $1", [gone.id]);

    const summary = await repo.serviceSummary(businessId, window);
    expect(summary.orders).toEqual({ taken: 3, completed: 1, cancelled: 1 });
  });

  it('leaves cancelled orders out of the money', async () => {
    // Nobody owes for food that was never made, and counting it makes a bad
    // night look like a good one.
    await anOrder(2000);
    const gone = await anOrder(5000);
    await pool.query("UPDATE food_orders SET stage = 'CANCELLED', closed_at = now() WHERE id = $1", [gone.id]);

    const summary = await repo.serviceSummary(businessId, window);
    expect(summary.money.soldCents).toBe(2000);
  });

  it('counts as outstanding only what is genuinely still owed', async () => {
    const unpaid = await anOrder(1000);
    const paid = await anOrder(2000);
    const waived = await anOrder(4000);
    await pool.query("UPDATE food_orders SET payment_state = 'UNPAID' WHERE id = $1", [unpaid.id]);
    await pool.query("UPDATE food_orders SET payment_state = 'PAID' WHERE id = $1", [paid.id]);
    await pool.query("UPDATE food_orders SET payment_state = 'WAIVED' WHERE id = $1", [waived.id]);

    const summary = await repo.serviceSummary(businessId, window);
    expect(summary.money.outstandingCents).toBe(1000);
  });

  it('reports nothing rather than zero when no order has finished', async () => {
    // A median of 0 minutes would read as "instant", which is worse than an
    // honest blank.
    await anOrder(1000);

    const summary = await repo.serviceSummary(businessId, window);
    expect(summary.service.medianMinutesToLeave).toBeNull();
    expect(summary.service.slowestMinutesToLeave).toBeNull();
  });

  it('ignores orders placed outside the window', async () => {
    const old = await anOrder(9999);
    await pool.query("UPDATE food_orders SET placed_at = now() - interval '10 days' WHERE id = $1", [old.id]);

    const summary = await repo.serviceSummary(businessId, window);
    expect(summary.orders.taken).toBe(0);
    expect(summary.money.soldCents).toBe(0);
  });

  it("never counts another business's service", async () => {
    const other = await createTestBusiness('Someone Else');
    await repo.saveSettings(other, { paymentRequiredBeforeKitchen: false }, null);
    await repo.createOrder({ businessId: other, fulfilmentMethod: 'PICKUP', items: [], subtotalCents: 0, totalCents: 5000 });

    const summary = await repo.serviceSummary(businessId, window);
    expect(summary.orders.taken).toBe(0);
  });

  describe('what is still owed', () => {
    it('is not bounded by the day', async () => {
      // The whole point of the list: an order unpaid from Tuesday is still
      // unpaid on Friday, and a summary that forgets it is how a debt
      // quietly becomes a write-off.
      const old = await anOrder(3000);
      await pool.query(
        "UPDATE food_orders SET payment_state = 'UNPAID', placed_at = now() - interval '10 days' WHERE id = $1",
        [old.id],
      );

      const outstanding = await repo.outstandingPayments(businessId);
      expect(outstanding.map((row) => row.orderId)).toContain(old.id);
    });

    it('leaves out what has been settled one way or another', async () => {
      const paid = await anOrder(1000);
      const waived = await anOrder(1000);
      await pool.query("UPDATE food_orders SET payment_state = 'PAID' WHERE id = $1", [paid.id]);
      await pool.query("UPDATE food_orders SET payment_state = 'WAIVED' WHERE id = $1", [waived.id]);

      expect(await repo.outstandingPayments(businessId)).toEqual([]);
    });

    it("never lists another business's debts", async () => {
      const other = await createTestBusiness('Someone Else');
      await repo.saveSettings(other, { paymentRequiredBeforeKitchen: false }, null);
      const theirs = await repo.createOrder({ businessId: other, fulfilmentMethod: 'PICKUP', items: [], subtotalCents: 0, totalCents: 1000 });
      await pool.query("UPDATE food_orders SET payment_state = 'UNPAID' WHERE id = $1", [theirs.id]);

      expect(await repo.outstandingPayments(businessId)).toEqual([]);
    });
  });
});
