import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import {
  FoodOperationsRepository,
  IllegalPaymentTransitionError,
  KitchenPaymentGateError,
  TableServiceDisabledError,
} from '../src/repositories/foodOperationsRepository.js';
import { FOOD_PAYMENT_STATES, canTransitionPayment, paymentReleasesKitchen, releaseToKitchen } from '../src/domain/food/paymentGate.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

describe('the payment gate', () => {
  let businessId: string;
  let userId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    userId = await createTestUser(businessId);
    repo = new FoodOperationsRepository(pool);
  });

  async function anOrder(overrides: Partial<Parameters<FoodOperationsRepository['createOrder']>[0]> = {}) {
    return repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [{ menuItemId: null, name: 'Chicken roti', variant: null, quantity: 1, unitPriceCents: 1200, modifiers: [], notes: null }],
      subtotalCents: 1200,
      totalCents: 1200,
      ...overrides,
    });
  }

  /** The rule the whole phase exists for. */
  it('will not let an unpaid order reach the kitchen', async () => {
    const order = await anOrder();
    expect(order.paymentState).toBe('UNPAID');

    await expect(repo.moveToStage(businessId, order.id, 'IN_KITCHEN')).rejects.toThrow(KitchenPaymentGateError);
    expect((await repo.findOrder(businessId, order.id))?.stage).toBe('NEW');
  });

  it('releases it the moment payment is recorded', async () => {
    const order = await anOrder();
    await repo.recordPayment(businessId, order.id, 'PAID', { method: 'BANK_TRANSFER', reference: 'TXN-88123', actorUserId: userId });

    const moved = await repo.moveToStage(businessId, order.id, 'IN_KITCHEN');
    expect(moved?.stage).toBe('IN_KITCHEN');
    expect(moved?.paidAt).not.toBeNull();
    expect(moved?.paymentReference).toBe('TXN-88123');
  });

  /**
   * "I paid" is a claim, not a receipt. A bank transfer that never lands
   * is the single most common way a small food business loses an order's
   * worth of food.
   */
  it('does not believe a customer who merely says they paid', async () => {
    const order = await anOrder();
    await repo.recordPayment(businessId, order.id, 'AWAITING_VERIFICATION', { actorKind: 'customer', note: 'customer says they sent it' });

    await expect(repo.moveToStage(businessId, order.id, 'IN_KITCHEN')).rejects.toThrow(KitchenPaymentGateError);

    const gate = await repo.checkKitchenRelease(businessId, order.id);
    expect(gate?.released).toBe(false);
    if (gate?.released) return;
    expect(gate?.customerFacing).toContain('confirm the payment');
  });

  /** Somebody is waiting on food and is entitled to know why it has not started. */
  it('says what to tell the customer, not just what went wrong', async () => {
    const order = await anOrder();
    await expect(repo.moveToStage(businessId, order.id, 'IN_KITCHEN')).rejects.toSatisfy(
      (error: unknown) => error instanceof KitchenPaymentGateError && error.customerFacing.length > 0,
    );
  });

  describe('the gate only guards the one handover that costs money', () => {
    /**
     * Everything after the kitchen is food that already exists. An order
     * refunded after it was cooked must still reach a counter or a driver,
     * or real food is stranded on a pass.
     */
    it('lets a cooked order finish even after a refund', async () => {
      const order = await anOrder();
      await repo.recordPayment(businessId, order.id, 'PAID', { actorUserId: userId });
      await repo.moveToStage(businessId, order.id, 'IN_KITCHEN');
      await repo.moveToStage(businessId, order.id, 'QUALITY_CHECK');
      await repo.recordPayment(businessId, order.id, 'REFUNDED', { actorUserId: userId });

      const ready = await repo.moveToStage(businessId, order.id, 'READY_FOR_PICKUP');
      expect(ready?.stage).toBe('READY_FOR_PICKUP');
    });
  });

  describe('a business that does not wait for money', () => {
    it('sends orders straight to the kitchen', async () => {
      await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, userId);
      const order = await anOrder();
      expect(order.paymentState).toBe('NOT_REQUIRED');
      expect((await repo.moveToStage(businessId, order.id, 'IN_KITCHEN'))?.stage).toBe('IN_KITCHEN');
    });

    /**
     * An owner switching the gate on halfway through service must not
     * silently re-close orders the kitchen has already started.
     */
    it('does not re-close orders already taken when the gate is switched on', async () => {
      await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, userId);
      const order = await anOrder();

      await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: true }, userId);
      expect((await repo.moveToStage(businessId, order.id, 'IN_KITCHEN'))?.stage).toBe('IN_KITCHEN');
    });
  });

  describe('a known customer who pays on delivery', () => {
    it('is cooked for without paying first', async () => {
      await repo.grantCustomerTerms({ businessId, phoneNumber: '+12462606993', note: 'shop next door, settles weekly', grantedBy: userId });

      const order = await anOrder({ customerPhone: '+12462606993' });
      expect(order.paymentState).toBe('WAIVED');
      expect(order.paymentWaiverKind).toBe('customer_terms');
      expect(order.paymentWaiverReason).toContain('settles weekly');

      expect((await repo.moveToStage(businessId, order.id, 'IN_KITCHEN'))?.stage).toBe('IN_KITCHEN');
    });

    /**
     * A waiver is not a payment. The money is still owed, and the record
     * an owner reconciles against must not claim it arrived.
     */
    it('is never recorded as having paid', async () => {
      await repo.grantCustomerTerms({ businessId, phoneNumber: '+12462606993', grantedBy: userId });
      const order = await anOrder({ customerPhone: '+12462606993' });
      expect(order.paymentState).not.toBe('PAID');
      expect(order.paidAt).toBeNull();
    });

    it('loses the exemption once it is revoked', async () => {
      const terms = await repo.grantCustomerTerms({ businessId, phoneNumber: '+12462606993', grantedBy: userId });
      expect(await repo.revokeCustomerTerms(businessId, terms.id)).toBe(true);

      const order = await anOrder({ customerPhone: '+12462606993' });
      expect(order.paymentState).toBe('UNPAID');
    });

    it('does not leak across businesses', async () => {
      await repo.grantCustomerTerms({ businessId, phoneNumber: '+12462606993', grantedBy: userId });
      const otherBusinessId = await createTestBusiness('Someone Else');
      const theirs = await repo.createOrder({
        businessId: otherBusinessId, fulfilmentMethod: 'PICKUP', items: [], subtotalCents: 0, totalCents: 0,
        customerPhone: '+12462606993',
      });
      expect(theirs.paymentState).toBe('UNPAID');
    });
  });

  describe('the owner standing in front of a customer', () => {
    it('can release an unpaid order, and it is written on the order', async () => {
      const order = await anOrder();
      const released = await repo.moveToStage(businessId, order.id, 'IN_KITCHEN', {
        userId,
        overridePaymentGate: { reason: 'regular, paying at the door' },
      });

      expect(released?.stage).toBe('IN_KITCHEN');

      // Recorded as a real waiver on the order, not merely noted in a log -
      // the next person to look must see it without reading history.
      const after = await repo.findOrder(businessId, order.id);
      expect(after?.paymentState).toBe('WAIVED');
      expect(after?.paymentWaiverKind).toBe('manual');
      expect(after?.paymentWaiverReason).toBe('regular, paying at the door');

      const events = await repo.listPaymentEvents(businessId, order.id);
      expect(events.some((event) => event.toState === 'WAIVED')).toBe(true);
    });
  });

  describe('the payment record', () => {
    it('keeps every change, with who made it', async () => {
      const order = await anOrder();
      await repo.recordPayment(businessId, order.id, 'AWAITING_VERIFICATION', { actorKind: 'customer' });
      await repo.recordPayment(businessId, order.id, 'PAID', { actorUserId: userId, method: 'CASH', amountCents: 1200 });

      const events = await repo.listPaymentEvents(businessId, order.id);
      expect(events.map((event) => event.toState)).toEqual(['AWAITING_VERIFICATION', 'PAID']);
      expect(events[1]?.amountCents).toBe(1200);
      expect(events[0]?.actorKind).toBe('customer');
    });

    /** Going back to unpaid would erase the fact that money arrived. That is a financial record, not a status. */
    it('will not un-pay an order', async () => {
      const order = await anOrder();
      await repo.recordPayment(businessId, order.id, 'PAID', { actorUserId: userId });
      await expect(repo.recordPayment(businessId, order.id, 'UNPAID', { actorUserId: userId })).rejects.toThrow(IllegalPaymentTransitionError);
    });

    it('stamps the paid time once', async () => {
      const order = await anOrder();
      const paid = await repo.recordPayment(businessId, order.id, 'PAID', { actorUserId: userId });
      await repo.recordPayment(businessId, order.id, 'REFUNDED', { actorUserId: userId });
      expect((await repo.findOrder(businessId, order.id))?.paidAt).toEqual(paid?.paidAt);
    });
  });

  describe('one customer action, one ticket', () => {
    /** A repeated webhook, a double tap on confirm, and a worker retry all mean the same order. */
    it('returns the same order for a repeated confirmation', async () => {
      const first = await anOrder({ idempotencyKey: 'wamid.CONFIRM123' });
      const second = await anOrder({ idempotencyKey: 'wamid.CONFIRM123' });
      expect(second.id).toBe(first.id);
      expect(second.orderNumber).toBe(first.orderNumber);

      const { rows } = await pool.query('SELECT 1 FROM food_orders WHERE business_id = $1', [businessId]);
      expect(rows).toHaveLength(1);
    });

    it('still takes two genuinely different orders', async () => {
      const first = await anOrder({ idempotencyKey: 'wamid.A' });
      const second = await anOrder({ idempotencyKey: 'wamid.B' });
      expect(second.id).not.toBe(first.id);
    });

    /** Counter orders have no originating message, so they must not collide on a null key. */
    it('does not collide orders keyed in by hand', async () => {
      await anOrder();
      await anOrder();
      const { rows } = await pool.query('SELECT 1 FROM food_orders WHERE business_id = $1', [businessId]);
      expect(rows).toHaveLength(2);
    });
  });

  describe('table service', () => {
    /** Built and shipped switched off: most food businesses here are takeaway and delivery. */
    it('is off until a business asks for it', async () => {
      expect((await repo.getSettings(businessId)).tableServiceEnabled).toBe(false);
      await expect(anOrder({ fulfilmentMethod: 'DINE_IN', tableLabel: 'T4' })).rejects.toThrow(TableServiceDisabledError);
    });

    it('takes dine-in orders once it is turned on', async () => {
      await repo.saveSettings(businessId, { tableServiceEnabled: true }, userId);
      const order = await anOrder({ fulfilmentMethod: 'DINE_IN', tableLabel: 'T4' });
      expect(order.fulfilmentMethod).toBe('DINE_IN');
      expect(order.tableLabel).toBe('T4');
    });

    /** A table order goes to a pass and waits to be carried, same as collection. */
    it('finishes at the pass, not with a driver', async () => {
      await repo.saveSettings(businessId, { tableServiceEnabled: true }, userId);
      await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, userId);
      const order = await anOrder({ fulfilmentMethod: 'DINE_IN', tableLabel: 'bar 2' });
      await repo.moveToStage(businessId, order.id, 'IN_KITCHEN');
      await repo.moveToStage(businessId, order.id, 'QUALITY_CHECK');
      expect((await repo.moveToStage(businessId, order.id, 'READY_FOR_PICKUP'))?.stage).toBe('READY_FOR_PICKUP');
    });
  });
});

describe('the payment state machine, on its own', () => {
  it('opens the kitchen only for states that really mean go', () => {
    // Order-independent: what matters is the SET that opens the kitchen,
    // not the order the states happen to be declared in.
    expect(new Set(FOOD_PAYMENT_STATES.filter(paymentReleasesKitchen))).toEqual(new Set(['PAID', 'WAIVED', 'NOT_REQUIRED']));
  });

  /** A state added later must be closed by default. This is a rule about giving away food. */
  it('blocks every state that is not on the allow-list', () => {
    for (const state of FOOD_PAYMENT_STATES.filter((candidate) => !['PAID', 'WAIVED', 'NOT_REQUIRED'].includes(candidate))) {
      expect(releaseToKitchen({ paymentState: state, paymentRequiredBeforeKitchen: true }).released).toBe(false);
    }
  });

  it('lets nothing out of a refund', () => {
    for (const state of FOOD_PAYMENT_STATES) expect(canTransitionPayment('REFUNDED', state)).toBe(false);
  });

  /** An owner's explicit decision outranks the rule - software must not argue with somebody facing a customer. */
  it('honours a manual override above everything else', () => {
    const release = releaseToKitchen({
      paymentState: 'UNPAID',
      paymentRequiredBeforeKitchen: true,
      manualOverride: { by: 'user-1', reason: 'regular' },
    });
    expect(release).toEqual({ released: true, via: 'manual_override' });
  });
});

describe('telling the customer payment is required', () => {
  let businessId: string;
  let userId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    userId = await createTestUser(businessId);
    repo = new FoodOperationsRepository(pool);
  });

  async function noticeFor(overrides: Partial<Parameters<FoodOperationsRepository['createOrder']>[0]> = {}) {
    const { paymentRequiredNotice } = await import('../src/services/food/paymentNotice.js');
    const order = await repo.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      items: [],
      subtotalCents: 2400,
      totalCents: 2400,
      currency: 'BBD',
      customerName: 'Ruth',
      ...overrides,
    });
    return paymentRequiredNotice(order, await repo.getSettings(businessId));
  }

  it('says what is owed, and that cooking waits on it', async () => {
    const notice = await noticeFor();
    expect(notice).toContain('Ruth');
    expect(notice).toContain('24.00');
    expect(notice).toContain('start cooking once the payment comes through');
  });

  it('uses the owner\'s own wording when they have written some', async () => {
    await repo.saveSettings(businessId, { paymentRequiredNotice: 'Order #{{order_number}} held until we see {{total}}.' }, userId);
    // Asserted on the amount rather than the symbol: how a currency code
    // renders is down to the platform's ICU data, not to this code.
    const notice = await noticeFor();
    expect(notice).toMatch(/^Order #1 held until we see .*24\.00\.$/);
  });

  /**
   * The three cases where sending this would be actively wrong. Each is a
   * real message reaching a real customer, so the guard is the feature.
   */
  describe('is never sent', () => {
    it('to a customer who already pays on delivery', async () => {
      await repo.grantCustomerTerms({ businessId, phoneNumber: '+12462606993', grantedBy: userId });
      expect(await noticeFor({ customerPhone: '+12462606993' })).toBeNull();
    });

    it('by a business that does not wait for money', async () => {
      await repo.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, userId);
      expect(await noticeFor()).toBeNull();
    });

    it('for an order that has already been paid', async () => {
      const { paymentRequiredNotice } = await import('../src/services/food/paymentNotice.js');
      const order = await repo.createOrder({ businessId, fulfilmentMethod: 'PICKUP', items: [], subtotalCents: 100, totalCents: 100 });
      const paid = await repo.recordPayment(businessId, order.id, 'PAID', { actorUserId: userId });
      expect(paymentRequiredNotice(paid!, await repo.getSettings(businessId))).toBeNull();
    });
  });

  /** "Thanks  — your order is saved" reads as a bug to the person receiving it. */
  it('reads properly when the customer has no name yet', async () => {
    const notice = await noticeFor({ customerName: null });
    expect(notice).not.toContain('  ');
    expect(notice).toMatch(/^Thanks —/);
  });

  it('still states the amount when the currency code is not one Intl knows', async () => {
    const notice = await noticeFor({ currency: 'XYZ' });
    expect(notice).toContain('24.00');
  });
});
