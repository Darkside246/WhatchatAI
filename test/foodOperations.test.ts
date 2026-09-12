import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository, IllegalStageTransitionError } from '../src/repositories/foodOperationsRepository.js';
import { checkDelivery, distanceMetres, findZoneFor, navigationUrl } from '../src/domain/food/deliveryZone.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('food operations (real Postgres)', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
  });

  async function anOrder(overrides: Partial<Parameters<FoodOperationsRepository['createOrder']>[0]> = {}) {
    return repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [{ menuItemId: null, name: 'Chicken roti', variant: null, quantity: 2, unitPriceCents: 1200, modifiers: [], notes: null }],
      subtotalCents: 2400,
      totalCents: 2400,
      ...overrides,
    });
  }

  describe('order numbers', () => {
    /** An operator reads these out over a pass. They have to start at 1 and stay small. */
    it('count from one, per business', async () => {
      expect((await anOrder()).orderNumber).toBe(1);
      expect((await anOrder()).orderNumber).toBe(2);

      const otherBusinessId = await createTestBusiness('Someone Else');
      const theirs = await repo.createOrder({
        businessId: otherBusinessId,
        fulfilmentMethod: 'PICKUP',
        items: [],
        subtotalCents: 0,
        totalCents: 0,
      });
      expect(theirs.orderNumber).toBe(1);
    });

    /** Two orders taken in the same instant is not hypothetical on a Friday night. */
    it('never collide when orders are taken at once', async () => {
      const orders = await Promise.all([anOrder(), anOrder(), anOrder(), anOrder(), anOrder()]);
      expect(new Set(orders.map((order) => order.orderNumber)).size).toBe(5);
    });
  });

  describe('moving through the kitchen', () => {
    it('runs a collection order the whole way, logging every stage', async () => {
      const order = await anOrder();

      for (const stage of ['IN_KITCHEN', 'QUALITY_CHECK', 'READY_FOR_PICKUP', 'COMPLETED'] as const) {
        const moved = await repo.moveToStage(businessId, order.id, stage);
        expect(moved?.stage).toBe(stage);
      }

      const events = await repo.listEvents(businessId, order.id);
      expect(events.map((event) => event.toStage)).toEqual(['NEW', 'IN_KITCHEN', 'QUALITY_CHECK', 'READY_FOR_PICKUP', 'COMPLETED']);
      // The order was taken by the customer, then worked by the team.
      expect(events[0]?.actorKind).toBe('customer');
    });

    /** The board must be impossible to drive into a state a kitchen cannot be in. */
    it('refuses a move the lifecycle does not allow', async () => {
      const order = await anOrder();
      await expect(repo.moveToStage(businessId, order.id, 'COMPLETED')).rejects.toThrow(IllegalStageTransitionError);
      expect((await repo.findOrder(businessId, order.id))?.stage).toBe('NEW');
    });

    it('stamps the closing time once, so a finished ticket stops ageing', async () => {
      const order = await anOrder();
      await repo.moveToStage(businessId, order.id, 'IN_KITCHEN');
      expect((await repo.findOrder(businessId, order.id))?.closedAt).toBeNull();

      await repo.moveToStage(businessId, order.id, 'QUALITY_CHECK');
      await repo.moveToStage(businessId, order.id, 'READY_FOR_PICKUP');
      const completed = await repo.moveToStage(businessId, order.id, 'COMPLETED');
      expect(completed?.closedAt).not.toBeNull();
    });

    /** An expediter finding a missing side sends it back, and the ticket goes live again. */
    it('lets the pass send a ticket back to the line', async () => {
      const order = await anOrder();
      await repo.moveToStage(businessId, order.id, 'IN_KITCHEN');
      await repo.moveToStage(businessId, order.id, 'QUALITY_CHECK');

      const returned = await repo.moveToStage(businessId, order.id, 'IN_KITCHEN', { kind: 'user', note: 'missing the sauce' });
      expect(returned?.stage).toBe('IN_KITCHEN');
      expect(returned?.closedAt).toBeNull();

      const events = await repo.listEvents(businessId, order.id);
      expect(events[events.length - 1]?.note).toBe('missing the sauce');
    });

    it('records a cancellation reason', async () => {
      const order = await anOrder();
      const cancelled = await repo.moveToStage(businessId, order.id, 'CANCELLED', { note: 'customer changed their mind' });
      expect(cancelled?.cancelReason).toBe('customer changed their mind');
    });

    it('is a no-op when the order is already where it is being sent', async () => {
      const order = await anOrder();
      expect((await repo.moveToStage(businessId, order.id, 'NEW'))?.stage).toBe('NEW');
    });

    /** A ticket id from another restaurant must never be movable. */
    it('cannot be moved across tenants', async () => {
      const order = await anOrder();
      const otherBusinessId = await createTestBusiness('Someone Else');
      expect(await repo.moveToStage(otherBusinessId, order.id, 'IN_KITCHEN')).toBeNull();
    });
  });

  describe('the board', () => {
    it('shows only what is still somebody\'s job, oldest first', async () => {
      const first = await anOrder();
      const second = await anOrder();
      await repo.moveToStage(businessId, first.id, 'IN_KITCHEN');

      const done = await anOrder();
      await repo.moveToStage(businessId, done.id, 'CANCELLED');

      const board = await repo.listBoard(businessId);
      expect(board.map((order) => order.orderNumber)).toEqual([first.orderNumber, second.orderNumber]);
    });
  });

  describe('the menu', () => {
    it('is marked out of stock in one write', async () => {
      const item = await repo.createMenuItem({ businessId, name: 'Fresh juice', priceCents: 800, aliases: ['juice'] });
      expect(item.available).toBe(true);

      await repo.setMenuItemAvailability(businessId, item.id, false);
      expect(await repo.listMenu(businessId, { availableOnly: true })).toHaveLength(0);
      expect(await repo.listMenu(businessId)).toHaveLength(1);
    });

    it('keeps the words customers actually use', async () => {
      const item = await repo.createMenuItem({ businessId, name: 'Large pepperoni pizza', priceCents: 1800, aliases: ['lg pep', '1lg pepperoni'] });
      expect(item.aliases).toEqual(['lg pep', '1lg pepperoni']);
    });
  });
});

describe('delivery zones', () => {
  const kitchen = { latitude: 13.0975, longitude: -59.6167 };

  const free = { id: 'z1', name: 'Nearby', centreLatitude: kitchen.latitude, centreLongitude: kitchen.longitude, radiusMetres: 3000, feeCents: 0, minimumOrderCents: 2000 };
  const paid = { id: 'z2', name: 'Wider', centreLatitude: kitchen.latitude, centreLongitude: kitchen.longitude, radiusMetres: 10_000, feeCents: 500, minimumOrderCents: 0 };

  it('measures a real distance', () => {
    expect(Math.round(distanceMetres(kitchen, kitchen))).toBe(0);
    // Roughly one degree of latitude - about 111km.
    expect(Math.round(distanceMetres(kitchen, { ...kitchen, latitude: kitchen.latitude + 1 }) / 1000)).toBe(111);
  });

  /**
   * Zones overlap by design - a small free radius inside a larger paid one.
   * Charging the higher fee to somebody who qualifies for the lower one
   * because of table order would be a quiet overcharge.
   */
  it('picks the cheapest zone that reaches, not the first', () => {
    const nearby = { latitude: kitchen.latitude + 0.01, longitude: kitchen.longitude };
    expect(findZoneFor(nearby, [paid, free])?.zone.id).toBe('z1');
    expect(findZoneFor(nearby, [free, paid])?.zone.id).toBe('z1');
  });

  it('charges for a drop that only the wider zone reaches', () => {
    const further = { latitude: kitchen.latitude + 0.05, longitude: kitchen.longitude };
    const check = checkDelivery(further, 3000, [free, paid]);
    expect(check).toMatchObject({ deliverable: true, feeCents: 500 });
  });

  it('says how far out of range a drop is, rather than only refusing', () => {
    const faraway = { latitude: kitchen.latitude + 1, longitude: kitchen.longitude };
    const check = checkDelivery(faraway, 3000, [free, paid]);
    expect(check.deliverable).toBe(false);
    if (check.deliverable) return;
    expect(check.reason).toBe('OUT_OF_RANGE');
    expect(check.nearestZoneMetres).toBeGreaterThan(100_000);
  });

  it('refuses a basket under what the zone will drive for', () => {
    const nearby = { latitude: kitchen.latitude + 0.01, longitude: kitchen.longitude };
    const check = checkDelivery(nearby, 500, [free]);
    expect(check).toMatchObject({ deliverable: false, reason: 'BELOW_MINIMUM', minimumOrderCents: 2000 });
  });

  /** The pin is the whole point: it cannot be misspelled or missing a postcode. */
  it('builds a driver link from the coordinates, never the typed address', () => {
    expect(navigationUrl({ latitude: 13.0975, longitude: -59.6167 })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=13.0975,-59.6167',
    );
  });
});
