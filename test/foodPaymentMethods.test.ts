import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository, PaymentMethodNotAvailableError } from '../src/repositories/foodOperationsRepository.js';
import { BIMPAY_BASIC_WALLET_LIMITS, PAYMENT_METHOD_CAPABILITIES, availableMethods, canEnable } from '../src/domain/food/paymentMethods.js';
import { buildPaymentAsk } from '../src/services/food/paymentRequest.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('how a business gets paid', () => {
  let businessId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    repo = new FoodOperationsRepository(pool);
  });

  async function anOrder(overrides: Record<string, unknown> = {}) {
    return repo.createOrder({
      businessId,
      fulfilmentMethod: 'DELIVERY',
      items: [{ menuItemId: null, name: 'Chicken roti', variant: null, quantity: 2, unitPriceCents: 1200, modifiers: [], notes: null }],
      subtotalCents: 2400,
      totalCents: 2400,
      currency: 'BBD',
      ...overrides,
    });
  }

  describe('what each rail can actually do', () => {
    /**
     * The rule the whole design rests on: how confirmation arrives is a
     * property of the METHOD, not a setting. There is no way for a business
     * to mark BiMPay as self-confirming, because a kitchen gate opened by
     * a confirmation nobody received is worse than no gate.
     */
    it('treats BiMPay and 1stPay as human-confirmed', () => {
      expect(PAYMENT_METHOD_CAPABILITIES.BIMPAY.confirmation).toBe('MANUAL');
      expect(PAYMENT_METHOD_CAPABILITIES.ONE_STPAY.confirmation).toBe('MANUAL');
      // Neither can be requested by us - both are created in a bank's own app.
      expect(PAYMENT_METHOD_CAPABILITIES.BIMPAY.auraCanRequest).toBe(false);
      expect(PAYMENT_METHOD_CAPABILITIES.ONE_STPAY.auraCanRequest).toBe(false);
    });

    /** The Central Bank is explicit: instant payments cannot be reversed. */
    it('records that BiMPay cannot be reversed', () => {
      expect(PAYMENT_METHOD_CAPABILITIES.BIMPAY.irrevocable).toBe(true);
      expect(PAYMENT_METHOD_CAPABILITIES.CASH.irrevocable).toBe(false);
    });

    /** An unbuilt integration must not be offerable at all. */
    it('does not offer a method that is not built', () => {
      expect(canEnable('WIPAY')).toBe(false);
      expect(canEnable('FAC')).toBe(false);
      expect(canEnable('BIMPAY')).toBe(true);
      expect(availableMethods().map((method) => method.key)).not.toContain('WIPAY');
    });

    it('refuses to switch on a method that is not built', async () => {
      await expect(repo.savePaymentMethod(businessId, 'WIPAY', { enabled: true })).rejects.toBeInstanceOf(
        PaymentMethodNotAvailableError,
      );
      expect(await repo.listPaymentMethods(businessId)).toHaveLength(0);
    });
  });

  describe('the message the customer gets', () => {
    it('carries the amount, the alias and the order number', async () => {
      const order = await anOrder();
      const ask = buildPaymentAsk(order, 'BIMPAY', { alias: '2460000000', aliasKind: 'MOBILE' });

      expect(ask.message).toContain('24.00');
      expect(ask.message).toContain('2460000000');
      // The reference is what makes six transfers at closing time
      // reconcilable, so it has to be in the sentence.
      expect(ask.message).toContain(`#${order.orderNumber}`);
    });

    /**
     * "Send it to 2460000000" leaves a customer guessing whether that is a
     * phone number or an account - and on a rail with no reversals, a
     * payment to the wrong kind of identifier is gone.
     */
    it('says which kind of alias it is', async () => {
      const order = await anOrder();
      expect(buildPaymentAsk(order, 'BIMPAY', { alias: '2460000000', aliasKind: 'MOBILE' }).message).toContain('mobile number 2460000000');
      expect(buildPaymentAsk(order, 'BIMPAY', { alias: 'pay@shop.bb', aliasKind: 'EMAIL' }).message).toContain('email address pay@shop.bb');
    });

    /** A method that needs an alias and has none must not send half a sentence. */
    it('refuses to send an ask with no alias, and says what is missing', async () => {
      const order = await anOrder();
      const ask = buildPaymentAsk(order, 'BIMPAY', { alias: null });
      expect(ask.message).toBeNull();
      expect(ask.reason).toContain('Your BiMPay alias or number');
    });

    /** Sending a bank alias to somebody standing at the counter would be absurd. */
    it('has nothing to send for cash or a card machine', async () => {
      const order = await anOrder();
      expect(buildPaymentAsk(order, 'CASH').message).toBeNull();
      expect(buildPaymentAsk(order, 'CARD_IN_PERSON').message).toBeNull();
    });

    it('uses the business own wording when they have written some', async () => {
      const order = await anOrder();
      const ask = buildPaymentAsk(order, 'BIMPAY', {
        alias: '2460000000',
        instructions: 'Send {{total}} to {{alias}}, reference {{order_number}}. Thanks.',
      });
      expect(ask.message).toBe(`Send $24.00 to 2460000000, reference ${order.orderNumber}. Thanks.`);
    });
  });

  describe('saving what a business accepts', () => {
    it('keeps an alias and its kind', async () => {
      const saved = await repo.savePaymentMethod(businessId, 'BIMPAY', {
        enabled: true,
        alias: '2460000000',
        aliasKind: 'MOBILE',
      });
      expect(saved).toMatchObject({ method: 'BIMPAY', enabled: true, alias: '2460000000', aliasKind: 'MOBILE' });
    });

    /** Saving one field must not blank the others. */
    it('touches only what was sent', async () => {
      await repo.savePaymentMethod(businessId, 'BIMPAY', { enabled: true, alias: '2460000000', aliasKind: 'MOBILE' });
      await repo.savePaymentMethod(businessId, 'BIMPAY', { instructions: 'Pay me' });

      const [saved] = await repo.listPaymentMethods(businessId);
      expect(saved).toMatchObject({ alias: '2460000000', aliasKind: 'MOBILE', instructions: 'Pay me', enabled: true });
    });

    /** Two rows claiming to be preferred is a screen that contradicts itself. */
    it('only ever has one preferred method', async () => {
      await repo.savePaymentMethod(businessId, 'BIMPAY', { enabled: true, alias: '2460000000' });
      await repo.savePaymentMethod(businessId, 'CASH', { enabled: true });

      await repo.setPreferredPaymentMethod(businessId, 'BIMPAY');
      await repo.setPreferredPaymentMethod(businessId, 'CASH');

      const preferred = (await repo.listPaymentMethods(businessId)).filter((entry) => entry.preferred);
      expect(preferred).toHaveLength(1);
      expect(preferred[0]?.method).toBe('CASH');
    });

    /** Preferring a method that is off would silently stop every ask going out. */
    it('will not prefer a method that is switched off', async () => {
      await repo.savePaymentMethod(businessId, 'BIMPAY', { enabled: false, alias: '2460000000' });
      expect(await repo.setPreferredPaymentMethod(businessId, 'BIMPAY')).toBeNull();
    });
  });

  describe('asking, and being told it arrived', () => {
    it('records what the customer was told, not what is configured now', async () => {
      const order = await anOrder();
      const request = await repo.recordPaymentRequest({
        businessId,
        orderId: order.id,
        method: 'BIMPAY',
        amountCents: order.totalCents,
        currency: order.currency,
        aliasAtRequest: '2460000000',
        messageSent: 'That comes to $24.00.',
      });

      // The business changes its alias afterwards.
      await repo.savePaymentMethod(businessId, 'BIMPAY', { alias: '2469999999' });

      const [stored] = await repo.listPaymentRequests(businessId, order.id);
      expect(stored?.aliasAtRequest).toBe('2460000000');
      expect(stored?.id).toBe(request.id);
    });

    it('confirms once, and not twice', async () => {
      const order = await anOrder();
      const request = await repo.recordPaymentRequest({
        businessId, orderId: order.id, method: 'BIMPAY', amountCents: 2400, currency: 'BBD',
      });

      const confirmed = await repo.confirmPaymentRequest(businessId, request.id, null, 'BP12345');
      expect(confirmed?.confirmedAt).not.toBeNull();
      expect(confirmed?.confirmationReference).toBe('BP12345');

      // A second confirmation is not a second payment.
      expect(await repo.confirmPaymentRequest(businessId, request.id, null, null)).toBeNull();
    });

    /** The board asks this for every ticket at once, not one card at a time. */
    it('reads the latest ask for a whole board in one query', async () => {
      const asked = await anOrder();
      const quiet = await anOrder();
      await repo.recordPaymentRequest({ businessId, orderId: asked.id, method: 'BIMPAY', amountCents: 2400, currency: 'BBD' });

      const latest = await repo.latestPaymentRequestByOrder(businessId, [asked.id, quiet.id]);
      expect(latest.get(asked.id)?.method).toBe('BIMPAY');
      expect(latest.has(quiet.id)).toBe(false);
    });

    it('does not show one business another\'s payment setup', async () => {
      await repo.savePaymentMethod(businessId, 'BIMPAY', { enabled: true, alias: '2460000000' });
      const otherBusinessId = await createTestBusiness('Someone Else');
      expect(await repo.listPaymentMethods(otherBusinessId)).toHaveLength(0);
    });
  });

  describe('what a wallet is allowed to receive', () => {
    /**
     * The Central Bank's published basic-wallet figures. A restaurant
     * passes the daily one on a quiet Friday lunch, and the failure mode is
     * the worst kind - payments stop arriving mid-service with food already
     * cooked.
     */
    it('knows the published basic wallet limits', () => {
      expect(BIMPAY_BASIC_WALLET_LIMITS.dailyCents).toBe(75_000);
      expect(BIMPAY_BASIC_WALLET_LIMITS.monthlyCents).toBe(250_000);
    });

    it('stores a limit, and treats not-told as different from unlimited', async () => {
      const saved = await repo.savePaymentMethod(businessId, 'BIMPAY', { alias: '2460000000', dailyReceiveLimitCents: 75_000 });
      expect(saved.dailyReceiveLimitCents).toBe(75_000);
      // A method nobody gave a limit for reads as null, not as zero - zero
      // would mean "can receive nothing" and warn on every order.
      const cash = await repo.savePaymentMethod(businessId, 'CASH', { enabled: true });
      expect(cash.dailyReceiveLimitCents).toBeNull();
    });

    /**
     * Counted from CONFIRMED requests only, and only those that came
     * through AURA - so it can undercount, which is why every sentence
     * built on it says "by our count".
     */
    it('counts only what it has actually seen confirmed', async () => {
      const first = await anOrder();
      const second = await anOrder();

      const asked = await repo.recordPaymentRequest({
        businessId, orderId: first.id, method: 'BIMPAY', amountCents: 2400, currency: 'BBD',
      });
      await repo.recordPaymentRequest({
        businessId, orderId: second.id, method: 'BIMPAY', amountCents: 5000, currency: 'BBD',
      });

      // Asked but unconfirmed counts for nothing - money nobody has seen is
      // not money received.
      expect((await repo.receivedOnMethod(businessId, 'BIMPAY')).todayCents).toBe(0);

      await repo.confirmPaymentRequest(businessId, asked.id, null, null);
      expect((await repo.receivedOnMethod(businessId, 'BIMPAY')).todayCents).toBe(2400);
    });

    it('counts each method separately', async () => {
      const order = await anOrder();
      const request = await repo.recordPaymentRequest({
        businessId, orderId: order.id, method: 'BIMPAY', amountCents: 2400, currency: 'BBD',
      });
      await repo.confirmPaymentRequest(businessId, request.id, null, null);

      expect((await repo.receivedOnMethod(businessId, 'ONE_STPAY')).todayCents).toBe(0);
    });
  });
});
