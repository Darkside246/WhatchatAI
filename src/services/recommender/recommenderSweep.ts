import { pool } from '../../db/pool.js';
import { RecommenderRepository, type RecommenderDomain } from '../../repositories/recommenderRepository.js';
import { rebuildDomain } from './rebuildRecommender.js';

/**
 * Recounting what goes with what, once a day.
 *
 * Nightly rather than on every order, because the answer barely moves: one
 * more roti does not change what people take with it, and recounting per
 * order would put an O(items squared) pass on the hot path of taking one.
 *
 * Only businesses that actually have history are touched, and the list is
 * derived from the orders themselves rather than from a business table -
 * a tenant that has never sold anything has nothing to count and should not
 * cost a query to discover that every night.
 */

const recommenderRepository = new RecommenderRepository(pool);

/** Domains, and the table that proves a business has any history in one. */
const DOMAIN_SOURCES: { domain: RecommenderDomain; sql: string }[] = [
  { domain: 'food', sql: "SELECT DISTINCT business_id FROM food_orders WHERE stage <> 'CANCELLED'" },
  { domain: 'retail', sql: "SELECT DISTINCT business_id FROM retail_orders WHERE status IN ('APPROVED', 'FULFILLED')" },
  { domain: 'property', sql: 'SELECT DISTINCT business_id FROM property_reservations' },
];

export interface SweepOutcome {
  businessesConsidered: number;
  rebuilt: number;
  failed: number;
}

export async function runRecommenderSweep(): Promise<SweepOutcome> {
  let considered = 0;
  let rebuilt = 0;
  let failed = 0;

  for (const source of DOMAIN_SOURCES) {
    let businessIds: string[] = [];
    try {
      const { rows } = await pool.query<{ business_id: string }>(source.sql);
      businessIds = rows.map((row) => row.business_id);
    } catch (error) {
      // A domain whose table does not exist in this deployment is not a
      // failure of the sweep - the other domains still rebuild.
      console.error(`[RecommenderSweep] Could not list ${source.domain} businesses:`, error instanceof Error ? error.message : error);
      continue;
    }

    for (const businessId of businessIds) {
      considered += 1;
      try {
        // One tenant at a time, deliberately serial. This runs overnight
        // with nobody waiting, and a burst of parallel full-table reads is
        // how a background job becomes the reason a kitchen's board is slow
        // at 3am in some other timezone.
        await rebuildDomain(recommenderRepository, businessId, source.domain);
        rebuilt += 1;
      } catch (error) {
        // One tenant's bad data must never stop every other tenant's
        // rebuild - the loop continues and the count is reported honestly.
        failed += 1;
        console.error(
          `[RecommenderSweep] ${source.domain} rebuild failed for business ${businessId}:`,
          error instanceof Error ? error.message : error,
        );
      }
    }
  }

  console.log(`[RecommenderSweep] Considered ${considered}, rebuilt ${rebuilt}, failed ${failed}`);
  return { businessesConsidered: considered, rebuilt, failed };
}
