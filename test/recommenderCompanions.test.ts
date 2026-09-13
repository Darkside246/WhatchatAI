import { beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../src/db/pool.js';
import { candidateKeys } from '../src/domain/recommender/itemMatch.js';
import { FoodOperationsRepository } from '../src/repositories/foodOperationsRepository.js';
import { RecommenderRepository } from '../src/repositories/recommenderRepository.js';
import { rebuildDomain } from '../src/services/recommender/rebuildRecommender.js';
import { suggestCompanions } from '../src/services/recommender/companionLookup.js';
import { createTestBusiness, resetDatabase } from './helpers.js';

describe('matching what the customer called it', () => {
  const menu = [
    { id: 'id-roti', name: 'Chicken roti', aliases: ['roti'] },
    { id: 'id-wings', name: 'Chicken wings', aliases: [] },
    { id: 'id-pizza', name: 'Pepperoni', aliases: [] },
  ];

  it('finds an item by its exact name, and offers its id first', () => {
    // The id is the key for any order taken after the dish was on the menu;
    // the name is the key for anything older. Both are tried, id first.
    expect(candidateKeys('Chicken roti', menu)).toEqual(['id-roti', 'chicken roti']);
  });

  it('finds an item by an alias the business set', () => {
    expect(candidateKeys('roti', menu)[0]).toBe('id-roti');
  });

  it('ignores case and stray spacing', () => {
    expect(candidateKeys('  CHICKEN   ROTI ', menu)[0]).toBe('id-roti');
  });

  it('finds an item inside a longer phrase', () => {
    // "the large pepperoni" is how somebody actually asks.
    expect(candidateKeys('the large pepperoni', menu)).toContain('id-pizza');
  });

  it('refuses to guess when a phrase fits more than one item', () => {
    // "chicken" is inside both the roti and the wings. Picking one anyway
    // means recommending companions for a dish nobody mentioned.
    const keys = candidateKeys('chicken', menu);
    expect(keys).not.toContain('id-roti');
    expect(keys).not.toContain('id-wings');
  });

  it('still offers the raw words for an item that is not on the menu', () => {
    // Orders taken before a dish was ever added are keyed by their line name.
    expect(candidateKeys('fish cutter', menu)).toEqual(['fish cutter']);
  });

  it('has nothing to look up for an empty ask', () => {
    expect(candidateKeys('   ', menu)).toEqual([]);
  });
});

describe('suggesting companions', () => {
  let businessId: string;
  let food: FoodOperationsRepository;
  let recommender: RecommenderRepository;

  beforeEach(async () => {
    await resetDatabase();
    businessId = await createTestBusiness('Aura Food');
    food = new FoodOperationsRepository(pool);
    recommender = new RecommenderRepository(pool);
    await food.saveSettings(businessId, { paymentRequiredBeforeKitchen: false }, null);
  });

  async function orderFor(phone: string, names: string[]) {
    return food.createOrder({
      businessId,
      fulfilmentMethod: 'PICKUP',
      customerPhone: phone,
      items: names.map((name) => ({ menuItemId: null, name, variant: null, quantity: 1, unitPriceCents: 1000, modifiers: [], notes: null })),
      subtotalCents: 1000 * names.length,
      totalCents: 1000 * names.length,
    });
  }

  it('says nothing when there is no history at all', async () => {
    const answer = await suggestCompanions(businessId, 'chicken roti');

    expect(answer.suggestions).toEqual([]);
    // The note is the whole point: a model handed an empty object fills the
    // silence, which is the failure this feature has to avoid.
    expect(answer.note).toContain('do not suggest');
  });

  it('reports a real pairing once enough customers have taken both', async () => {
    // The floor is three customers - fewer is a coincidence, not a habit.
    for (const phone of ['2465550101', '2465550102', '2465550103']) {
      await orderFor(phone, ['Chicken roti', 'Mauby']);
    }
    await rebuildDomain(recommender, businessId, 'food');

    const answer = await suggestCompanions(businessId, 'chicken roti');
    expect(answer.suggestions.map((s) => s.name)).toContain('Mauby');
    // The evidence is a sentence an owner could check, not a score.
    expect(answer.suggestions[0]?.evidence).toContain('customers');
  });

  it('stays silent below the evidence floor', async () => {
    for (const phone of ['2465550101', '2465550102']) {
      await orderFor(phone, ['Chicken roti', 'Mauby']);
    }
    await rebuildDomain(recommender, businessId, 'food');

    expect((await suggestCompanions(businessId, 'chicken roti')).suggestions).toEqual([]);
  });

  it('counts a customer once however many times they order', async () => {
    // One regular ordering the same pair nightly is one person's habit, not
    // a pattern across a clientele.
    for (let time = 0; time < 5; time += 1) await orderFor('2465550101', ['Chicken roti', 'Mauby']);
    await rebuildDomain(recommender, businessId, 'food');

    expect((await suggestCompanions(businessId, 'chicken roti')).suggestions).toEqual([]);
  });

  it("never reads another business's habits", async () => {
    const other = await createTestBusiness('Someone Else');
    await food.saveSettings(other, { paymentRequiredBeforeKitchen: false }, null);
    for (const phone of ['2465550101', '2465550102', '2465550103']) {
      await food.createOrder({
        businessId: other,
        fulfilmentMethod: 'PICKUP',
        customerPhone: phone,
        items: [
          { menuItemId: null, name: 'Chicken roti', variant: null, quantity: 1, unitPriceCents: 1000, modifiers: [], notes: null },
          { menuItemId: null, name: 'Mauby', variant: null, quantity: 1, unitPriceCents: 500, modifiers: [], notes: null },
        ],
        subtotalCents: 1500,
        totalCents: 1500,
      });
    }
    await rebuildDomain(recommender, other, 'food');

    expect((await suggestCompanions(businessId, 'chicken roti')).suggestions).toEqual([]);
  });

  it('handles an item with spaces in its name', async () => {
    // The pair keys used to be a joined string that was split back out,
    // which broke on the first dish called "chicken roti".
    for (const phone of ['2465550101', '2465550102', '2465550103']) {
      await orderFor(phone, ['Chicken roti', 'Sweet potato fries']);
    }
    await rebuildDomain(recommender, businessId, 'food');

    expect((await suggestCompanions(businessId, 'chicken roti')).suggestions.map((s) => s.name)).toContain(
      'Sweet potato fries',
    );
  });
});
