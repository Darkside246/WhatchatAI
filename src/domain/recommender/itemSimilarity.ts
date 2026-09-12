/**
 * "People who bought this also bought that", computed honestly.
 *
 * THE SHAPE OF THE DATA, which decides the whole design. The three
 * verticals do not look alike:
 *
 *   - food and retail have BASKETS. One order contains several items, so
 *     two items co-occur inside a single transaction.
 *   - property has no basket. A reservation is one unit. Two units only
 *     ever relate through the same customer booking both, months apart.
 *
 * A model built on within-order co-occurrence would therefore work for two
 * verticals and return nothing at all for the third. So the unit of
 * co-occurrence here is the CUSTOMER, not the order: two items are related
 * when the same people took both. Basket co-occurrence is then a special
 * case that falls out for free, and property works without a second model.
 *
 * WHAT THIS DELIBERATELY IS NOT. No embeddings, no matrix factorisation, no
 * model to train or serve. A business with forty menu items and nine
 * hundred orders does not have a machine-learning problem; it has a
 * counting problem, and counting is auditable - an owner can be told
 * exactly why a suggestion appeared, which is not true of a latent factor.
 */

export interface ItemPairObservation {
  itemA: string;
  itemB: string;
  /** Distinct customers who took both. */
  pairCustomers: number;
  /** Distinct customers who took A at all, and B at all. */
  aCustomers: number;
  bCustomers: number;
}

export interface ScoredPair extends ItemPairObservation {
  /**
   * Cosine similarity: pair / sqrt(a * b). Between 0 and 1.
   *
   * Chosen over two obvious alternatives for reasons that matter on small
   * data. Raw co-occurrence count just resurfaces the most popular item on
   * the menu next to everything - true, useless, and it makes the feature
   * look broken. Lift divides by expected frequency and so explodes on
   * rare items: two customers who both happened to order the one lobster
   * dish produce a spectacular score off no evidence. Cosine is bounded,
   * symmetric, and penalises the popular item's inflated denominator.
   */
  score: number;
}

/**
 * How much evidence is needed before a pair may be spoken out loud.
 *
 * MIN_PAIR_CUSTOMERS is the honesty guard and the most important number
 * here. Two customers is a coincidence; three is the floor at which a
 * pattern is worth repeating to a stranger. A recommender that speaks
 * confidently from one co-occurrence is worse than no recommender, because
 * it spends the customer's trust on noise - and an owner who hears the
 * agent suggest something absurd switches the whole thing off.
 */
export const MIN_PAIR_CUSTOMERS = 3;
/** Below this the items are barely related; saying so would be filler. */
export const MIN_SCORE = 0.15;

export function cosineScore(observation: ItemPairObservation): number {
  const { pairCustomers, aCustomers, bCustomers } = observation;
  if (pairCustomers <= 0 || aCustomers <= 0 || bCustomers <= 0) return 0;
  // Guarded rather than trusted: a pair count larger than either side's own
  // count means the counts were gathered inconsistently, and a similarity
  // above 1 would quietly sort to the top of every list.
  const bounded = Math.min(pairCustomers, aCustomers, bCustomers);
  return bounded / Math.sqrt(aCustomers * bCustomers);
}

export function scorePair(observation: ItemPairObservation): ScoredPair {
  return { ...observation, score: cosineScore(observation) };
}

/** Whether a pair has earned the right to be mentioned to a customer. */
export function isWorthSaying(pair: ScoredPair): boolean {
  return pair.pairCustomers >= MIN_PAIR_CUSTOMERS && pair.score >= MIN_SCORE;
}

/**
 * The best companions for one item, strongest first.
 *
 * Ties break on the number of customers rather than alphabetically, because
 * between two equally similar items the one more people actually bought is
 * the safer thing to say.
 */
export function companionsFor(item: string, pairs: ScoredPair[], limit = 3): ScoredPair[] {
  return pairs
    .filter((pair) => (pair.itemA === item || pair.itemB === item) && isWorthSaying(pair))
    .sort((left, right) => right.score - left.score || right.pairCustomers - left.pairCustomers)
    .slice(0, limit);
}

/** The other half of a pair - whichever end is not the item asked about. */
export function otherSide(pair: ItemPairObservation, item: string): string {
  return pair.itemA === item ? pair.itemB : pair.itemA;
}

/**
 * Why this was suggested, in a sentence an owner can check.
 *
 * The whole reason for counting rather than learning: a suggestion nobody
 * can explain is a suggestion nobody can correct. An owner who reads "4 of
 * the people who ordered this also ordered that" can tell us we are wrong,
 * which they cannot do with a latent factor.
 */
export function explain(pair: ScoredPair, item: string): string {
  const other = otherSide(pair, item);
  return `${pair.pairCustomers} of the ${pair.itemA === item ? pair.aCustomers : pair.bCustomers} people who took ${item} also took ${other}.`;
}
