import { cosineScore, MIN_PAIR_CUSTOMERS, MIN_SCORE } from '../../domain/recommender/itemSimilarity.js';
import type { BuildOutcome, CustomerItem, RecommenderDomain, RecommenderRepository, StoredPair } from '../../repositories/recommenderRepository.js';

/**
 * Counting who took what alongside what.
 *
 * Done in memory rather than in SQL on purpose. The self-join that produces
 * pairs is O(items squared) per customer, and expressing it as one query
 * buries the two decisions that actually matter - what counts as a customer,
 * and what counts as enough evidence - inside a statement nobody can test.
 * Here the counting is a pure function over a list, so those judgements are
 * testable without a database.
 *
 * The scale genuinely permits it. A business with a thousand customers and
 * forty items is forty thousand rows and a few hundred pairs. This is a
 * nightly job over one tenant, not a request path.
 */

/** A customer who took this many distinct items is not a signal, they are a menu sweep. */
const MAX_ITEMS_PER_CUSTOMER = 60;

export interface PairCounts {
  pairs: StoredPair[];
  customersConsidered: number;
  itemsConsidered: number;
}

/**
 * Turns (customer, item) rows into scored pairs.
 *
 * Exported separately from the rebuild so the counting can be exercised
 * without a database, which is where the judgements live.
 */
export function countPairs(interactions: CustomerItem[]): PairCounts {
  /** item -> the customers who took it. A Set, so one person ordering a dish twice counts once. */
  const customersByItem = new Map<string, Set<string>>();
  /** customer -> their distinct items. */
  const itemsByCustomer = new Map<string, Set<string>>();
  const labels = new Map<string, string>();

  for (const interaction of interactions) {
    const item = interaction.itemKey.trim();
    const customer = interaction.customerKey.trim();
    if (!item || !customer) continue;

    // First label wins, so a dish renamed halfway through a year of orders
    // is spoken about by one name rather than alternating between two.
    if (!labels.has(item)) labels.set(item, interaction.label.trim() || item);

    if (!customersByItem.has(item)) customersByItem.set(item, new Set());
    customersByItem.get(item)!.add(customer);

    if (!itemsByCustomer.has(customer)) itemsByCustomer.set(customer, new Set());
    itemsByCustomer.get(customer)!.add(item);
  }

  /**
   * How many customers took each pair.
   *
   * The pair's two halves are kept as a tuple rather than encoded into the
   * key and split back out. Item keys are UUIDs OR lowercased item names,
   * and a name contains spaces - so any separator-and-split scheme breaks on
   * the first dish called "chicken roti". Keeping the tuple removes the
   * whole class of bug instead of choosing a separator and hoping.
   */
  const pairCounts = new Map<string, { itemA: string; itemB: string; together: number }>();

  for (const items of itemsByCustomer.values()) {
    // A customer who has had most of the menu says nothing about what goes
    // WITH what - they correlate everything with everything. Skipped rather
    // than down-weighted, because the weighting that would fix it is another
    // number nobody can check.
    if (items.size < 2 || items.size > MAX_ITEMS_PER_CUSTOMER) continue;

    const sorted = [...items].sort();
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const itemA = sorted[i]!;
        const itemB = sorted[j]!;
        // Lower key first, always, so a pair accumulates in one bucket
        // rather than two that later disagree with each other.
        const key = JSON.stringify([itemA, itemB]);
        const existing = pairCounts.get(key);
        if (existing) existing.together += 1;
        else pairCounts.set(key, { itemA, itemB, together: 1 });
      }
    }
  }

  const pairs: StoredPair[] = [];
  for (const { itemA, itemB, together } of pairCounts.values()) {
    const aCustomers = customersByItem.get(itemA)?.size ?? 0;
    const bCustomers = customersByItem.get(itemB)?.size ?? 0;

    const observation = { itemA, itemB, pairCustomers: together, aCustomers, bCustomers };
    const score = cosineScore(observation);

    // Filtered at build time, not only at read time. Storing noise means
    // every future reader has to remember to exclude it, and one of them
    // eventually will not.
    if (together < MIN_PAIR_CUSTOMERS || score < MIN_SCORE) continue;

    pairs.push({
      ...observation,
      score,
      itemALabel: labels.get(itemA) ?? itemA,
      itemBLabel: labels.get(itemB) ?? itemB,
    });
  }

  return {
    pairs: pairs.sort((left, right) => right.score - left.score || right.pairCustomers - left.pairCustomers),
    customersConsidered: itemsByCustomer.size,
    itemsConsidered: customersByItem.size,
  };
}

/**
 * Rebuilds one domain for one business.
 *
 * Reports `tooLittleData` rather than an empty success when there is not
 * enough history to say anything at all. An honest "not yet" is a different
 * fact from "nothing goes together", and a screen that cannot tell them
 * apart will tell an owner their customers have no habits when really their
 * shop is three weeks old.
 */
export async function rebuildDomain(
  repository: RecommenderRepository,
  businessId: string,
  domain: RecommenderDomain,
): Promise<BuildOutcome> {
  const interactions = await (domain === 'food'
    ? repository.foodInteractions(businessId)
    : domain === 'retail'
      ? repository.retailInteractions(businessId)
      : repository.propertyInteractions(businessId));

  const counted = countPairs(interactions);

  // Means the floor could not have been reached by anything, rather than
  // that this business's customers happen to be unpredictable.
  const tooLittleData = counted.pairs.length === 0 && counted.customersConsidered < MIN_PAIR_CUSTOMERS;

  return repository.replacePairs(businessId, domain, counted.pairs, {
    customersConsidered: counted.customersConsidered,
    itemsConsidered: counted.itemsConsidered,
    tooLittleData,
  });
}
