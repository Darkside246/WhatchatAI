import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  FoodOperationsRepository,
  IllegalAssignmentTransitionError,
  OrderAlreadyAssignedError,
  OrderNotDeliverableError,
} from '../src/repositories/foodOperationsRepository.js';
import { canTransitionAssignment, isFinalAssignmentState, whyNotAssignable } from '../src/domain/food/driverAssignment.js';
import { DEFAULT_NOTIFICATION_TEMPLATES, NOTIFICATION_MERGE_FIELDS, notificationFor } from '../src/services/food/orderNotifications.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('who has the food', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
    await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, null);
  });

  async function aDelivery(overrides: Record<string, unknown> = {}) {
    return repo.createOrder({
      businessId,
      fulfilmentMethod: 'DELIVERY',
      items: [{ menuItemId: null, name: 'Chicken roti', variant: null, quantity: 1, unitPriceCents: 1200, modifiers: [], notes: null }],
      subtotalCents: 1200,
      totalCents: 1200,
      ...overrides,
    });
  }

  describe('the ladder', () => {
    /**
     * An assignment can be undone before the driver takes anything - the
     * wrong name tapped on a list. Never once the food is collected: at
     * that point the driver is holding it, and a record saying otherwise
     * lies about where somebody's dinner is.
     */
    it('can be cancelled before collection and never after', () => {
      expect(canTransitionAssignment('ASSIGNED', 'CANCELLED')).toBe(true);
      expect(canTransitionAssignment('COLLECTED', 'CANCELLED')).toBe(false);
    });

    /** A failed attempt is not the end - the food is still in a car and has to come back. */
    it('lets a failed run come back or be tried again', () => {
      expect(canTransitionAssignment('FAILED', 'RETURNED')).toBe(true);
      expect(canTransitionAssignment('FAILED', 'COLLECTED')).toBe(true);
      expect(isFinalAssignmentState('FAILED')).toBe(false);
      expect(isFinalAssignmentState('DELIVERED')).toBe(true);
      expect(isFinalAssignmentState('RETURNED')).toBe(true);
    });

    /** Every refusal is something somebody on a screen has to be told. */
    it('says why an order cannot have a driver', () => {
      expect(whyNotAssignable({ fulfilmentMethod: 'PICKUP', stage: 'NEW' })).toContain('collected');
      expect(whyNotAssignable({ fulfilmentMethod: 'DINE_IN', stage: 'NEW' })).toContain('eating in');
      expect(whyNotAssignable({ fulfilmentMethod: 'DELIVERY', stage: 'CANCELLED' })).toContain('cancelled');
      expect(whyNotAssignable({ fulfilmentMethod: 'DELIVERY', stage: 'QUALITY_CHECK' })).toBeNull();
    });
  });

  describe('assigning', () => {
    it('puts a named driver on an order', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Marcus', vehicle: 'blue van', phoneNumber: '2460000000' });
      const order = await aDelivery();

      const delivery = await repo.assignDriver(businessId, order.id, driver.id);
      expect(delivery).toMatchObject({ driverId: driver.id, driverName: 'Marcus', driverVehicle: 'blue van', state: 'ASSIGNED' });

      // Carried on the assignment, so a board never needs a second lookup
      // to say who has the food.
      const live = await repo.findLiveDelivery(businessId, order.id);
      expect(live?.driverName).toBe('Marcus');
      expect(live?.driverPhone).toBe('2460000000');
    });

    /**
     * Two people assigning two drivers in the same moment is exactly what
     * happens during a rush. The second one has to lose, and it loses in
     * the database rather than in a check-then-write race.
     */
    it('refuses a second live driver on the same order', async () => {
      const first = await repo.createDriver({ businessId, name: 'Marcus' });
      const second = await repo.createDriver({ businessId, name: 'Ama' });
      const order = await aDelivery();

      await repo.assignDriver(businessId, order.id, first.id);
      await expect(repo.assignDriver(businessId, order.id, second.id)).rejects.toBeInstanceOf(OrderAlreadyAssignedError);
    });

    /** Unassigning frees the order, so the right driver can be picked. */
    it('lets a different driver take it once the first is unassigned', async () => {
      const first = await repo.createDriver({ businessId, name: 'Marcus' });
      const second = await repo.createDriver({ businessId, name: 'Ama' });
      const order = await aDelivery();

      const wrong = await repo.assignDriver(businessId, order.id, first.id);
      await repo.moveDelivery(businessId, wrong!.id, 'CANCELLED');

      const right = await repo.assignDriver(businessId, order.id, second.id);
      expect(right?.driverName).toBe('Ama');
      expect((await repo.findLiveDelivery(businessId, order.id))?.driverName).toBe('Ama');
    });

    it('refuses an order nobody is driving anywhere', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Marcus' });
      const collection = await aDelivery({ fulfilmentMethod: 'PICKUP' });

      await expect(repo.assignDriver(businessId, collection.id, driver.id)).rejects.toBeInstanceOf(OrderNotDeliverableError);
    });

    /** A driver who no longer works here must not appear on a ticket. */
    it('refuses a driver who has stopped driving here', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Marcus' });
      await repo.setDriverActive(businessId, driver.id, false);
      const order = await aDelivery();

      expect(await repo.assignDriver(businessId, order.id, driver.id)).toBeNull();
    });

    it('refuses another business\'s driver', async () => {
      const otherBusinessId = await createTestBusiness('Someone Else');
      const theirs = await repo.createDriver({ businessId: otherBusinessId, name: 'Marcus' });
      const order = await aDelivery();

      expect(await repo.assignDriver(businessId, order.id, theirs.id)).toBeNull();
    });
  });

  describe('the run', () => {
    async function anAssignedOrder() {
      const driver = await repo.createDriver({ businessId, name: 'Marcus' });
      const order = await aDelivery();
      const delivery = await repo.assignDriver(businessId, order.id, driver.id);
      return { driver, order, delivery: delivery! };
    }

    it('stamps when the driver took it and when it was done', async () => {
      const { delivery } = await anAssignedOrder();

      const collected = await repo.moveDelivery(businessId, delivery.id, 'COLLECTED');
      expect(collected?.collectedAt).not.toBeNull();
      expect(collected?.finishedAt).toBeNull();

      const delivered = await repo.moveDelivery(businessId, delivery.id, 'DELIVERED');
      expect(delivered?.finishedAt).not.toBeNull();
      // Finished, so it no longer holds the order's one live slot.
      expect(await repo.findLiveDelivery(businessId, delivery.orderId)).toBeNull();
    });

    /** "Failed" on its own tells the next person nothing they can act on. */
    it('will not record a failure without a reason', async () => {
      const { delivery } = await anAssignedOrder();
      await repo.moveDelivery(businessId, delivery.id, 'COLLECTED');

      await expect(repo.moveDelivery(businessId, delivery.id, 'FAILED')).rejects.toBeInstanceOf(IllegalAssignmentTransitionError);

      const failed = await repo.moveDelivery(businessId, delivery.id, 'FAILED', { failureReason: 'nobody in' });
      expect(failed?.failureReason).toBe('nobody in');
    });

    it('refuses a move the ladder does not allow', async () => {
      const { delivery } = await anAssignedOrder();
      await expect(repo.moveDelivery(businessId, delivery.id, 'DELIVERED')).rejects.toBeInstanceOf(IllegalAssignmentTransitionError);
    });

    it('lists what a driver has carried', async () => {
      const { driver, delivery } = await anAssignedOrder();
      await repo.moveDelivery(businessId, delivery.id, 'COLLECTED');
      await repo.moveDelivery(businessId, delivery.id, 'DELIVERED');

      const runs = await repo.listDriverRuns(businessId, driver.id);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.state).toBe('DELIVERED');
    });

    /** The board asks this for every ticket at once, not one card at a time. */
    it('reads every live assignment on the board in one query', async () => {
      const { order, delivery } = await anAssignedOrder();
      const quiet = await aDelivery();

      const live = await repo.liveDeliveriesByOrder(businessId, [order.id, quiet.id]);
      expect(live.get(order.id)?.id).toBe(delivery.id);
      expect(live.has(quiet.id)).toBe(false);
    });
  });

  describe('a driver who leaves', () => {
    /**
     * There is no delete. Their deliveries are a record of what happened,
     * and the schema's ON DELETE RESTRICT makes deactivating the only
     * route rather than merely the recommended one.
     */
    it('keeps their deliveries and drops off the picker', async () => {
      const driver = await repo.createDriver({ businessId, name: 'Marcus' });
      const order = await aDelivery();
      const delivery = await repo.assignDriver(businessId, order.id, driver.id);
      await repo.moveDelivery(businessId, delivery!.id, 'COLLECTED');
      await repo.moveDelivery(businessId, delivery!.id, 'DELIVERED');

      await repo.setDriverActive(businessId, driver.id, false);

      expect(await repo.listDrivers(businessId, { activeOnly: true })).toHaveLength(0);
      expect(await repo.listDrivers(businessId)).toHaveLength(1);
      expect(await repo.listDriverRuns(businessId, driver.id)).toHaveLength(1);
    });

    /** A name freed up by somebody leaving can be used again. */
    it('frees their name for somebody new', async () => {
      const first = await repo.createDriver({ businessId, name: 'Marcus' });
      await expect(repo.createDriver({ businessId, name: 'marcus' })).rejects.toThrow();

      await repo.setDriverActive(businessId, first.id, false);
      const second = await repo.createDriver({ businessId, name: 'Marcus' });
      expect(second.id).not.toBe(first.id);
    });
  });

  it('does not show one business another\'s drivers', async () => {
    await repo.createDriver({ businessId, name: 'Marcus' });
    const otherBusinessId = await createTestBusiness('Someone Else');
    expect(await repo.listDrivers(otherBusinessId)).toHaveLength(0);
  });

  describe('telling the customer who is bringing it', () => {
    /**
     * Offered, never assumed. Telling a customer an employee's name is the
     * business's decision to make, so the shipped wording does not use it.
     */
    it('is a token a business can use, and is not in the default wording', () => {
      expect(NOTIFICATION_MERGE_FIELDS.map((field) => field.token)).toContain('{{driver}}');
      for (const template of Object.values(DEFAULT_NOTIFICATION_TEMPLATES)) {
        expect(template).not.toContain('{{driver}}');
      }
    });

    it('fills the driver in when a business asks for it', async () => {
      await repo.saveSettings(
        businessId,
        {
          notificationVerbosity: 'CUSTOM',
          notificationOverrides: { OUT_FOR_DELIVERY: { enabled: true, template: '{{driver}} is on the way with your order.' } },
        },
        null,
      );

      const order = await aDelivery({ chatId: null });
      const settings = await repo.getSettings(businessId);

      // A counter order has no conversation, so there is nobody to tell -
      // the wording is exercised through an order that has one below.
      expect(notificationFor('OUT_FOR_DELIVERY', order, settings, { driverName: 'Marcus' })).toBeNull();

      const withChat = { ...order, chatId: '00000000-0000-4000-8000-000000000001' };
      expect(notificationFor('OUT_FOR_DELIVERY', withChat, settings, { driverName: 'Marcus' })).toBe(
        'Marcus is on the way with your order.',
      );
    });

    /**
     * The alternative was substituting an empty string, which would send a
     * real customer "Your order is on the way with." - worse than the
     * plain default, and the kind of thing nobody notices until it has
     * gone out a hundred times.
     */
    it('falls back to our wording when nobody has been assigned yet', async () => {
      await repo.saveSettings(
        businessId,
        {
          notificationVerbosity: 'CUSTOM',
          notificationOverrides: { OUT_FOR_DELIVERY: { enabled: true, template: 'Your order is on the way with {{driver}}.' } },
        },
        null,
      );

      const order = { ...(await aDelivery()), chatId: '00000000-0000-4000-8000-000000000001' };
      const settings = await repo.getSettings(businessId);

      expect(notificationFor('OUT_FOR_DELIVERY', order, settings)).toBe(DEFAULT_NOTIFICATION_TEMPLATES.OUT_FOR_DELIVERY);
    });
  });
});
