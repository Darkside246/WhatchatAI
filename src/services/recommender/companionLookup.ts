import { pool } from '../../db/pool.js';
import { FoodOperationsRepository } from '../../repositories/foodOperationsRepository.js';
import { RecommenderRepository, type RecommenderDomain } from '../../repositories/recommenderRepository.js';
import { candidateKeys } from '../../domain/recommender/itemMatch.js';
import { companionToolResponse } from './recommenderTool.js';

/**
 * What this business's own customers usually take alongside something.
 *
 * Reads only what the nightly count already stored - it never counts on the
 * fly and never falls back to "something else from the menu". An empty
 * answer is a real answer here, and the tool response says so in words the
 * model is meant to act on, because a model handed nothing will helpfully
 * fill the silence and that is the exact failure this feature must avoid.
 */

const foodOperationsRepository = new FoodOperationsRepository(pool);
const recommenderRepository = new RecommenderRepository(pool);

export async function suggestCompanions(
  businessId: string,
  item: string,
  domain: RecommenderDomain = 'food',
): Promise<ReturnType<typeof companionToolResponse>> {
  const menu = domain === 'food' ? await foodOperationsRepository.listMenu(businessId) : [];
  const keys = candidateKeys(
    item,
    menu.map((entry) => ({ id: entry.id, name: entry.name, aliases: entry.aliases })),
  );

  for (const key of keys) {
    const companions = await recommenderRepository.companionsFor(businessId, domain, key);
    // The first key with any history wins. Merging across keys would double
    // count the same customer, who appears under both the id and the name
    // for a dish that was on the menu for only part of its history.
    if (companions.length > 0) {
      return companionToolResponse(
        item,
        companions.map((companion) => ({
          label: companion.label,
          pairCustomers: companion.pairCustomers,
          ofCustomers: companion.ofCustomers,
        })),
      );
    }
  }

  return companionToolResponse(item, []);
}
