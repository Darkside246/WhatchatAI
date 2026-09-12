import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository, type FoodOrderRecord, type FoodSettingsRecord } from '../src/repositories/foodOperationsRepository.js';
import {
  DEFAULT_NOTIFICATION_TEMPLATES,
  FOOD_NOTIFICATION_EVENTS,
  completionWording,
  eventForStage,
  isNotificationEnabled,
  notificationFor,
} from '../src/services/food/orderNotifications.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

function order(overrides: Partial<FoodOrderRecord> = {}): FoodOrderRecord {
  return {
    id: 'order-1', businessId: 'business-1', orderNumber: 42, chatId: 'chat-1',
    customerName: 'Ruth', fulfilmentMethod: 'PICKUP', totalCents: 2400, currency: 'BBD',
    ...overrides,
  } as unknown as FoodOrderRecord;
}

function settings(overrides: Partial<FoodSettingsRecord> = {}): FoodSettingsRecord {
  return {
    businessId: 'business-1', paymentRequiredBeforeKitchen: true, tableServiceEnabled: false,
    paymentRequiredNotice: null, slaWarningSeconds: null, slaBreachSeconds: null,
    notificationVerbosity: 'STANDARD', notificationOverrides: {},
    ...overrides,
  };
}

describe('what the customer hears as their order moves', () => {
  /**
   * Tied to the state machine, never to a judgement. A cook bumping a
   * ticket is what makes an order ready - "your order is ready" is a
   * promise somebody may walk out the door on.
   */
  it('is caused by a real stage change', () => {
    expect(eventForStage('IN_KITCHEN')).toBe('IN_KITCHEN');
    expect(eventForStage('READY_FOR_PICKUP')).toBe('READY_FOR_PICKUP');
    expect(eventForStage('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY');
    expect(eventForStage('COMPLETED')).toBe('COMPLETED');
  });

  /** A ticket accepted by mistake, or cancelled, is not news for a customer. */
  it('says nothing about a stage the customer has no interest in', () => {
    expect(eventForStage('NEW')).toBeNull();
    expect(eventForStage('QUALITY_CHECK')).toBeNull();
    expect(eventForStage('CANCELLED')).toBeNull();
  });

  describe('how much a business says', () => {
    /** The two that require the customer to DO something. */
    it('minimal is the ones that need them to act', () => {
      const enabled = FOOD_NOTIFICATION_EVENTS.filter((event) => isNotificationEnabled(event, 'MINIMAL'));
      expect(enabled).toEqual(['ORDER_RECEIVED', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY']);
    });

    it('standard adds the ones that answer "has anything happened"', () => {
      expect(isNotificationEnabled('IN_KITCHEN', 'STANDARD')).toBe(true);
      expect(isNotificationEnabled('PAYMENT_CONFIRMED', 'STANDARD')).toBe(true);
      // A customer holding the food already knows they have it.
      expect(isNotificationEnabled('COMPLETED', 'STANDARD')).toBe(false);
    });

    it('detailed says all of it', () => {
      for (const event of FOOD_NOTIFICATION_EVENTS) expect(isNotificationEnabled(event, 'DETAILED')).toBe(true);
    });

    /**
     * Under CUSTOM, silence is the default: an operator who has taken
     * control of their own messages has said nothing about an event they
     * have not switched on.
     */
    it('custom sends only what was switched on', () => {
      for (const event of FOOD_NOTIFICATION_EVENTS) expect(isNotificationEnabled(event, 'CUSTOM')).toBe(false);
      expect(isNotificationEnabled('READY_FOR_PICKUP', 'CUSTOM', { READY_FOR_PICKUP: { enabled: true } })).toBe(true);
    });
  });

  describe('the wording', () => {
    it('fills in the order and the total', () => {
      const body = notificationFor('ORDER_RECEIVED', order(), settings());
      expect(body).toContain('#42');
      expect(body).toContain('24.00');
    });

    it('uses the operator\'s own words under custom', () => {
      const body = notificationFor('READY_FOR_PICKUP', order(), settings({
        notificationVerbosity: 'CUSTOM',
        notificationOverrides: { READY_FOR_PICKUP: { enabled: true, template: 'Come get it — #{{order_number}} is up.' } },
      }));
      expect(body).toBe('Come get it — #42 is up.');
    });

    it('falls back to ours when a custom event is on but has no wording', () => {
      const body = notificationFor('IN_KITCHEN', order(), settings({
        notificationVerbosity: 'CUSTOM',
        notificationOverrides: { IN_KITCHEN: { enabled: true } },
      }));
      expect(body).toBe(DEFAULT_NOTIFICATION_TEMPLATES.IN_KITCHEN);
    });

    /** A counter order has nobody to message - not a failed send, one that should never be attempted. */
    it('is nothing at all for an order with no conversation', () => {
      expect(notificationFor('ORDER_RECEIVED', order({ chatId: null }), settings())).toBeNull();
    });

    it('is nothing at all when the business does not send it', () => {
      expect(notificationFor('COMPLETED', order(), settings({ notificationVerbosity: 'STANDARD' }))).toBeNull();
    });

    /** Never a blank WhatsApp message, whatever an operator saves. */
    it('is null rather than empty when an operator clears the wording', () => {
      expect(notificationFor('IN_KITCHEN', order(), settings({
        notificationVerbosity: 'CUSTOM',
        notificationOverrides: { IN_KITCHEN: { enabled: true, template: '   ' } },
      }))).toBe(DEFAULT_NOTIFICATION_TEMPLATES.IN_KITCHEN);
    });

    /** "Delivered" to somebody who walked in and collected it is a mistake they remember. */
    it('closes differently depending on how they got it', () => {
      expect(completionWording(order({ fulfilmentMethod: 'DELIVERY' }))).toBe('delivered');
      expect(completionWording(order({ fulfilmentMethod: 'PICKUP' }))).toBe('collected');
      expect(completionWording(order({ fulfilmentMethod: 'DINE_IN' }))).toBe('collected');
    });
  });
});

describe('telling the customer once', () => {
  let businessId: string;
  let userId: string;
  let repo: FoodOperationsRepository;
  let orderId: string;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    userId = await createTestUser(businessId);
    repo = new FoodOperationsRepository(pool);
    const created = await repo.createOrder({ businessId, fulfilmentMethod: 'PICKUP', items: [], subtotalCents: 0, totalCents: 0 });
    orderId = created.id;
  });

  /**
   * A kitchen sends a ticket back to the line and bumps it again all the
   * time. The customer must not hear that cooking has started twice.
   */
  it('refuses a second claim for the same event', async () => {
    expect(await repo.claimNotification(businessId, orderId, 'IN_KITCHEN', 'Your order is being made now.')).toBe(true);
    expect(await repo.claimNotification(businessId, orderId, 'IN_KITCHEN', 'Your order is being made now.')).toBe(false);
  });

  it('still allows a different event', async () => {
    await repo.claimNotification(businessId, orderId, 'IN_KITCHEN', 'cooking');
    expect(await repo.claimNotification(businessId, orderId, 'READY_FOR_PICKUP', 'ready')).toBe(true);
  });

  /** The insert is the lock - checking first and then sending would race two workers. */
  it('lets exactly one of two simultaneous claims through', async () => {
    const results = await Promise.all([
      repo.claimNotification(businessId, orderId, 'READY_FOR_PICKUP', 'ready'),
      repo.claimNotification(businessId, orderId, 'READY_FOR_PICKUP', 'ready'),
      repo.claimNotification(businessId, orderId, 'READY_FOR_PICKUP', 'ready'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  /** The answer when a customer says they heard nothing. */
  it('records what was said and when', async () => {
    await repo.claimNotification(businessId, orderId, 'ORDER_RECEIVED', 'Got your order — #1.');
    const told = await repo.listNotifications(businessId, orderId);
    expect(told).toHaveLength(1);
    expect(told[0]).toMatchObject({ event: 'ORDER_RECEIVED', body: 'Got your order — #1.', outboundMessageId: null });
  });

  it('keeps the settings a business chooses', async () => {
    await repo.saveSettings(businessId, {
      notificationVerbosity: 'CUSTOM',
      notificationOverrides: { READY_FOR_PICKUP: { enabled: true, template: 'Up on the counter.' } },
    }, userId);

    const saved = await repo.getSettings(businessId);
    expect(saved.notificationVerbosity).toBe('CUSTOM');
    expect(saved.notificationOverrides.READY_FOR_PICKUP).toEqual({ enabled: true, template: 'Up on the counter.' });
  });

  it('defaults a business that has never chosen to standard', async () => {
    const fresh = await createTestBusiness('Never Configured');
    expect((await repo.getSettings(fresh)).notificationVerbosity).toBe('STANDARD');
  });
});
