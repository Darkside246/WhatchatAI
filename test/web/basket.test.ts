import { describe, expect, it } from 'vitest';
import { basketLineKey } from '../../src/web/src/lib/basket.js';

/**
 * What counts as the same line on a till.
 *
 * If two genuinely different things share an identity, tapping the second
 * increments the first and the kitchen is handed a ticket for food nobody
 * ordered - and the customer finds out, not the shop.
 */
describe('basket line identity', () => {
  it('treats the same item with no options as one line', () => {
    expect(basketLineKey('burger', [])).toBe(basketLineKey('burger', []));
  });

  it('never merges a plain item with a modified one', () => {
    // The failure this exists to prevent.
    expect(basketLineKey('burger', [])).not.toBe(basketLineKey('burger', [{ name: 'onions', action: 'remove' }]));
  });

  it('never merges two different items', () => {
    expect(basketLineKey('burger', [])).not.toBe(basketLineKey('fries', []));
  });

  it('does not care which order the options were tapped in', () => {
    // A cashier should not end up with two rows for one burger because of
    // the order they pressed things.
    const a = basketLineKey('burger', [
      { name: 'cheese', action: 'add' },
      { name: 'bacon', action: 'add' },
    ]);
    const b = basketLineKey('burger', [
      { name: 'bacon', action: 'add' },
      { name: 'cheese', action: 'add' },
    ]);
    expect(a).toBe(b);
  });

  it('separates adding something from taking it away', () => {
    // "extra onions" and "no onions" are opposite instructions to a kitchen.
    expect(basketLineKey('burger', [{ name: 'onions', action: 'add' }])).not.toBe(
      basketLineKey('burger', [{ name: 'onions', action: 'remove' }]),
    );
  });

  it('separates on-the-side from on-it', () => {
    expect(basketLineKey('salad', [{ name: 'ranch', action: 'add' }])).not.toBe(
      basketLineKey('salad', [{ name: 'ranch', action: 'on_side' }]),
    );
  });

  it('survives names with spaces and punctuation', () => {
    // The same lesson as the recommender's pair keys: every
    // separator-and-split scheme breaks on the first "chicken roti".
    const a = basketLineKey('id-1', [{ name: 'extra hot sauce', action: 'add' }]);
    const b = basketLineKey('id-1', [{ name: 'extra', action: 'add' }, { name: 'hot sauce', action: 'add' }]);
    expect(a).not.toBe(b);
  });

  it('separates two items whose ids differ only by suffix', () => {
    expect(basketLineKey('burger', [])).not.toBe(basketLineKey('burger-2', []));
  });
});
