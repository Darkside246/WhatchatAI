import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { confirmProposal, matchMenuItem, resolveProposal, type DraftOrderProposal } from '../src/services/food/orderIntake.js';
import { createTestBusiness, createTestUser, resetDatabase } from './helpers.js';

describe('turning what the agent understood into a real order', () => {
  let businessId: string;
  let userId: string;
  let repo: FoodOperationsRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    userId = await createTestUser(businessId);
    repo = new FoodOperationsRepository(pool);

    await repo.createMenuItem({
      businessId, name: 'Large pepperoni pizza', priceCents: 1800, currency: 'BBD',
      aliases: ['lg pep', 'large pep', 'pepperoni'],
      modifiers: [{ name: 'garlic mayo', priceDeltaCents: 150 }, { name: 'extra cheese', priceDeltaCents: 300 }],
    });
    await repo.createMenuItem({ businessId, name: 'Soda', priceCents: 400, currency: 'BBD', aliases: ['drink', 'bank'] });
  });

  function proposal(overrides: Partial<DraftOrderProposal> = {}): DraftOrderProposal {
    return { fulfilmentMethod: 'PICKUP', lines: [{ reference: 'lg pep', quantity: 1 }], ...overrides };
  }

  describe('matching what the customer said', () => {
    it('finds an item by the words their own customers use', async () => {
      const menu = await repo.listMenu(businessId);
      // "1lg pep" and "2x soda" are how people really write it - the
      // quantity glued to the item, with no word boundary between them.
      for (const said of ['lg pep', 'LG PEP', 'large pep', '1lg pep please', '2x large pep', 'Large pepperoni pizza']) {
        expect(matchMenuItem(said, menu)?.name).toBe('Large pepperoni pizza');
      }
    });

    it('prefers the longest match, not the first', async () => {
      const menu = await repo.listMenu(businessId);
      expect(matchMenuItem('one large pepperoni pizza and a drink', menu)?.name).toBe('Large pepperoni pizza');
    });

    it('finds nothing rather than guessing', async () => {
      const menu = await repo.listMenu(businessId);
      expect(matchMenuItem('lasagne', menu)).toBeNull();
      // A fragment is not a match - "za" must not resolve to "pizza".
      expect(matchMenuItem('za', menu)).toBeNull();
    });
  });

  describe('pricing', () => {
    /**
     * The single most important behaviour here: the price comes from the
     * catalogue row read at confirmation, and there is no path by which a
     * caller can supply one.
     */
    it('comes from the catalogue, never from the proposal', async () => {
      const result = await resolveProposal(repo, businessId, proposal({ lines: [{ reference: 'lg pep', quantity: 2 }] }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.lines[0]?.unitPriceCents).toBe(1800);
      expect(result.resolved.subtotalCents).toBe(3600);
      expect(result.resolved.currency).toBe('BBD');
    });

    it('charges for a declared extra', async () => {
      const result = await resolveProposal(repo, businessId, proposal({
        lines: [{ reference: 'lg pep', quantity: 1, modifiers: [{ name: 'garlic mayo', action: 'add' }] }],
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.totalCents).toBe(1950);
    });

    /** A customer can ask for no onions on anything, and it is always free. */
    it('never charges for taking something off', async () => {
      const result = await resolveProposal(repo, businessId, proposal({
        lines: [{ reference: 'lg pep', quantity: 1, modifiers: [{ name: 'onions', action: 'remove' }] }],
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.totalCents).toBe(1800);
      expect(result.resolved.lines[0]?.modifiers[0]).toMatchObject({ name: 'onions', action: 'remove', priceDeltaCents: 0 });
    });

    /**
     * Charging nothing for something that costs money would be wrong;
     * refusing the order over an undeclared sauce would be worse. It
     * reaches the cook either way.
     */
    it('passes an undeclared extra to the kitchen as a note', async () => {
      const result = await resolveProposal(repo, businessId, proposal({
        lines: [{ reference: 'lg pep', quantity: 1, modifiers: [{ name: 'ketchup', action: 'on_side' }] }],
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.lines[0]?.notes).toContain('ketchup on the side');
      expect(result.resolved.lines[0]?.modifiers).toHaveLength(0);
      expect(result.resolved.totalCents).toBe(1800);
    });
  });

  describe('refuses, and says what to ask the customer', () => {
    it('an item that is not on the menu', async () => {
      const result = await resolveProposal(repo, businessId, proposal({ lines: [{ reference: 'lasagne', quantity: 1 }] }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems[0]).toMatchObject({ kind: 'unknown_item', reference: 'lasagne' });
      expect(result.problems[0]?.customerFacing).toContain('could you tell me which item you meant');
    });

    /** A kitchen runs out mid-conversation, so this is checked at confirmation. */
    it('an item that sold out while they were deciding', async () => {
      const [pizza] = await repo.listMenu(businessId);
      await repo.setMenuItemAvailability(businessId, pizza!.id, false);

      const result = await resolveProposal(repo, businessId, proposal());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems[0]).toMatchObject({ kind: 'unavailable', name: 'Large pepperoni pizza' });
      expect(result.problems[0]?.customerFacing).toContain('run out');
    });

    it('an empty order', async () => {
      const result = await resolveProposal(repo, businessId, proposal({ lines: [] }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems.some((problem) => problem.kind === 'no_items')).toBe(true);
    });

    /** Asked about everything at once, rather than led through one correction at a time. */
    it('everything wrong with it, not just the first thing', async () => {
      const result = await resolveProposal(repo, businessId, proposal({
        lines: [{ reference: 'lasagne', quantity: 1 }, { reference: 'sushi', quantity: 1 }],
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems.filter((problem) => problem.kind === 'unknown_item')).toHaveLength(2);
    });
  });

  describe('delivery', () => {
    it('asks for a pin rather than a typed address', async () => {
      const result = await resolveProposal(repo, businessId, proposal({ fulfilmentMethod: 'DELIVERY' }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems[0]).toMatchObject({ kind: 'delivery_location_missing' });
      expect(result.problems[0]?.customerFacing).toContain('share your location');
    });

    it('adds the zone fee to the total', async () => {
      await repo.createZone({ businessId, name: 'Town', centreLatitude: 13.0975, centreLongitude: -59.6167, radiusMetres: 10_000, feeCents: 500, minimumOrderCents: 0 });

      const result = await resolveProposal(repo, businessId, proposal({
        fulfilmentMethod: 'DELIVERY', deliveryLatitude: 13.1, deliveryLongitude: -59.6167,
      }));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.resolved.deliveryFeeCents).toBe(500);
      expect(result.resolved.totalCents).toBe(2300);
    });

    it('offers collection when the address is out of range', async () => {
      await repo.createZone({ businessId, name: 'Town', centreLatitude: 13.0975, centreLongitude: -59.6167, radiusMetres: 3000, feeCents: 0, minimumOrderCents: 0 });

      const result = await resolveProposal(repo, businessId, proposal({
        fulfilmentMethod: 'DELIVERY', deliveryLatitude: 14.5, deliveryLongitude: -59.6167,
      }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems[0]?.customerFacing).toContain('collect it');
    });

    /** A business that has not set a delivery area up still delivers. */
    it('does not refuse when no zones are configured', async () => {
      const result = await resolveProposal(repo, businessId, proposal({
        fulfilmentMethod: 'DELIVERY', deliveryLatitude: 13.1, deliveryLongitude: -59.6167,
      }));
      expect(result.ok).toBe(true);
    });
  });

  describe('confirming', () => {
    it('creates a real ticket on the board, with the payment notice to send', async () => {
      const result = await confirmProposal(repo, businessId, proposal({ customerName: 'Ruth', chatId: null }), {
        idempotencyKey: 'wamid.YES1',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.confirmed.order.orderNumber).toBe(1);
      expect(result.confirmed.order.stage).toBe('NEW');
      expect(result.confirmed.order.paymentState).toBe('UNPAID');
      expect(result.confirmed.notice).toContain('start cooking once the payment');

      expect(await repo.listBoard(businessId)).toHaveLength(1);
    });

    /** One customer action, one ticket - whatever the webhook does. */
    it('returns the same order for a repeated confirmation', async () => {
      const first = await confirmProposal(repo, businessId, proposal(), { idempotencyKey: 'wamid.YES1' });
      const second = await confirmProposal(repo, businessId, proposal(), { idempotencyKey: 'wamid.YES1' });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      expect(second.confirmed.order.id).toBe(first.confirmed.order.id);
      expect(second.confirmed.deduplicated).toBe(true);
      expect(await repo.listBoard(businessId)).toHaveLength(1);
    });

    /**
     * A replayed confirmation must not be re-priced against a catalogue
     * that has moved on, nor report a problem about an order that was
     * already taken successfully.
     */
    it('honours a replay even after the item sold out', async () => {
      await confirmProposal(repo, businessId, proposal(), { idempotencyKey: 'wamid.YES1' });
      const [pizza] = await repo.listMenu(businessId);
      await repo.setMenuItemAvailability(businessId, pizza!.id, false);

      const replay = await confirmProposal(repo, businessId, proposal(), { idempotencyKey: 'wamid.YES1' });
      expect(replay.ok).toBe(true);
    });

    it('does not create anything when the order cannot be priced', async () => {
      const result = await confirmProposal(repo, businessId, proposal({ lines: [{ reference: 'lasagne', quantity: 1 }] }), {
        idempotencyKey: 'wamid.YES2',
      });
      expect(result.ok).toBe(false);
      expect(await repo.listBoard(businessId)).toHaveLength(0);
    });

    it('sends no payment notice to a customer who pays on delivery', async () => {
      await repo.grantCustomerTerms({ businessId, phoneNumber: '+12462606993', note: 'regular', grantedBy: userId });
      const result = await confirmProposal(repo, businessId, proposal({ customerPhone: '+12462606993' }), { idempotencyKey: 'wamid.YES3' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.confirmed.notice).toBeNull();
      expect(result.confirmed.order.paymentState).toBe('WAIVED');
    });

    /** The end-to-end rule: a confirmed order still waits for money. */
    it('still will not reach the kitchen unpaid', async () => {
      const result = await confirmProposal(repo, businessId, proposal(), { idempotencyKey: 'wamid.YES4' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      await expect(repo.moveToStage(businessId, result.confirmed.order.id, 'IN_KITCHEN')).rejects.toThrow();
    });
  });
});
