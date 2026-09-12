import { describe, expect, it } from 'vitest';
import {
  MIN_PAIR_CUSTOMERS,
  companionsFor,
  cosineScore,
  explain,
  isWorthSaying,
  scorePair,
} from '../src/domain/recommender/itemSimilarity.js';
import { countPairs } from '../src/services/recommender/rebuildRecommender.js';
import type { CustomerItem } from '../src/repositories/recommenderRepository.js';

function took(customer: string, items: string[]): CustomerItem[] {
  return items.map((item) => ({ customerKey: customer, itemKey: item, label: item }));
}

describe('what goes with what', () => {
  describe('scoring', () => {
    /**
     * Cosine over raw counts, because a raw count just resurfaces the most
     * popular item next to everything - true, useless, and it makes the
     * feature look broken.
     */
    it('does not rank a popular item above a genuinely related one', () => {
      // Chips are ordered by nearly everybody, so they co-occur with the
      // burger often in absolute terms.
      const chips = scorePair({ itemA: 'burger', itemB: 'chips', pairCustomers: 20, aCustomers: 25, bCustomers: 100 });
      // The milkshake is rarer but almost always taken WITH a burger.
      const shake = scorePair({ itemA: 'burger', itemB: 'shake', pairCustomers: 18, aCustomers: 25, bCustomers: 20 });

      expect(shake.score).toBeGreaterThan(chips.score);
    });

    /** Lift would explode here off two coincidences; cosine stays bounded. */
    it('never exceeds one, however the counts arrive', () => {
      expect(cosineScore({ itemA: 'a', itemB: 'b', pairCustomers: 2, aCustomers: 2, bCustomers: 2 })).toBe(1);
      // Counts gathered inconsistently must not produce a similarity above 1
      // that would sort to the top of every list.
      expect(cosineScore({ itemA: 'a', itemB: 'b', pairCustomers: 99, aCustomers: 2, bCustomers: 2 })).toBeLessThanOrEqual(1);
    });

    it('is zero when anything is missing', () => {
      expect(cosineScore({ itemA: 'a', itemB: 'b', pairCustomers: 0, aCustomers: 5, bCustomers: 5 })).toBe(0);
      expect(cosineScore({ itemA: 'a', itemB: 'b', pairCustomers: 3, aCustomers: 0, bCustomers: 5 })).toBe(0);
    });
  });

  describe('the evidence floor', () => {
    /**
     * The most important rule in the feature. Two customers is a
     * coincidence. A recommender that speaks from one co-occurrence spends
     * the customer\'s trust on noise.
     */
    it('will not say anything from fewer than three customers', () => {
      const thin = scorePair({ itemA: 'a', itemB: 'b', pairCustomers: 2, aCustomers: 2, bCustomers: 2 });
      // A perfect score on two customers is still not worth saying.
      expect(thin.score).toBe(1);
      expect(isWorthSaying(thin)).toBe(false);

      const real = scorePair({ itemA: 'a', itemB: 'b', pairCustomers: MIN_PAIR_CUSTOMERS, aCustomers: 4, bCustomers: 4 });
      expect(isWorthSaying(real)).toBe(true);
    });

    it('will not say anything barely related', () => {
      const weak = scorePair({ itemA: 'a', itemB: 'b', pairCustomers: 3, aCustomers: 200, bCustomers: 200 });
      expect(weak.score).toBeLessThan(0.15);
      expect(isWorthSaying(weak)).toBe(false);
    });
  });

  describe('counting over real shapes of data', () => {
    /** Food and retail: several items inside one order. */
    it('finds a pairing from baskets', () => {
      const { pairs } = countPairs([
        ...took('ama', ['roti', 'mauby']),
        ...took('ben', ['roti', 'mauby']),
        ...took('cleo', ['roti', 'mauby']),
      ]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0]).toMatchObject({ itemA: 'mauby', itemB: 'roti', pairCustomers: 3 });
    });

    /**
     * Property has no basket at all - a reservation is one property. The
     * only co-occurrence is the same guest returning to a different one,
     * which is exactly why counting is per customer rather than per
     * transaction. A basket model returns nothing here.
     */
    it('finds a pairing across a customer\'s history, with no basket anywhere', () => {
      const { pairs } = countPairs([
        ...took('ama', ['beach-villa']),
        ...took('ama', ['ridge-house']),
        ...took('ben', ['beach-villa']),
        ...took('ben', ['ridge-house']),
        ...took('cleo', ['beach-villa']),
        ...took('cleo', ['ridge-house']),
      ]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.pairCustomers).toBe(3);
    });

    /** One person ordering the same dish weekly is one customer, not twelve. */
    it('counts a repeat customer once', () => {
      const { pairs } = countPairs([
        ...took('ama', ['roti', 'mauby']),
        ...took('ama', ['roti', 'mauby']),
        ...took('ama', ['roti', 'mauby']),
      ]);
      expect(pairs).toHaveLength(0);
    });

    /**
     * Somebody who has had most of the menu correlates everything with
     * everything and tells us nothing about what goes together.
     */
    it('ignores a customer who has swept the menu', () => {
      const menu = Array.from({ length: 61 }, (_, index) => `item-${index}`);
      const { pairs, customersConsidered } = countPairs(took('sweeper', menu));
      expect(pairs).toHaveLength(0);
      // Still counted as a customer seen - the exclusion is from PAIRING,
      // not from existing.
      expect(customersConsidered).toBe(1);
    });

    /**
     * Item keys can be lowercased names, and names contain spaces. An
     * earlier version encoded a pair into one string and split it back,
     * which broke on the first dish called "chicken roti".
     */
    it('handles item names containing spaces', () => {
      const { pairs } = countPairs([
        ...took('ama', ['chicken roti', 'ginger beer']),
        ...took('ben', ['chicken roti', 'ginger beer']),
        ...took('cleo', ['chicken roti', 'ginger beer']),
      ]);

      expect(pairs).toHaveLength(1);
      expect(pairs[0]?.itemA).toBe('chicken roti');
      expect(pairs[0]?.itemB).toBe('ginger beer');
    });

    it('keeps the first name it saw for a renamed item', () => {
      const { pairs } = countPairs([
        { customerKey: 'ama', itemKey: 'sku-1', label: 'Beef burger' },
        { customerKey: 'ama', itemKey: 'sku-2', label: 'Chips' },
        { customerKey: 'ben', itemKey: 'sku-1', label: 'Aged beef burger' },
        { customerKey: 'ben', itemKey: 'sku-2', label: 'Chips' },
        { customerKey: 'cleo', itemKey: 'sku-1', label: 'Aged beef burger' },
        { customerKey: 'cleo', itemKey: 'sku-2', label: 'Chips' },
      ]);
      expect(pairs[0]?.itemALabel).toBe('Beef burger');
    });

    it('says nothing at all from a shop three weeks old', () => {
      const { pairs } = countPairs([...took('ama', ['roti', 'mauby']), ...took('ben', ['roti', 'mauby'])]);
      expect(pairs).toHaveLength(0);
    });
  });

  describe('picking what to say', () => {
    const pairs = [
      scorePair({ itemA: 'roti', itemB: 'mauby', pairCustomers: 9, aCustomers: 10, bCustomers: 12 }),
      scorePair({ itemA: 'roti', itemB: 'chips', pairCustomers: 4, aCustomers: 10, bCustomers: 80 }),
      scorePair({ itemA: 'burger', itemB: 'shake', pairCustomers: 8, aCustomers: 9, bCustomers: 9 }),
    ];

    it('returns only companions of the item asked about, strongest first', () => {
      const found = companionsFor('roti', pairs);
      expect(found.map((pair) => (pair.itemA === 'roti' ? pair.itemB : pair.itemA))).toEqual(['mauby']);
    });

    /** Counting rather than learning, so a suggestion can always be explained. */
    it('explains itself in a sentence an owner can check', () => {
      expect(explain(pairs[0]!, 'roti')).toBe('9 of the 10 people who took roti also took mauby.');
    });
  });
});
