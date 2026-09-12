import type { Queryable } from './types.js';
import { MIN_PAIR_CUSTOMERS, MIN_SCORE, cosineScore, type ScoredPair } from '../domain/recommender/itemSimilarity.js';

export type RecommenderDomain = 'food' | 'retail' | 'property';

export interface CustomerItem {
  /** Who took it. A contact id, or a phone number when no contact resolved. */
  customerKey: string;
  /** The catalogue id - a menu item, a product, a unit. */
  itemKey: string;
  /** What to call it out loud. */
  label: string;
}

export interface StoredPair extends ScoredPair {
  itemALabel: string;
  itemBLabel: string;
}

export interface BuildOutcome {
  domain: RecommenderDomain;
  customersConsidered: number;
  itemsConsidered: number;
  pairsStored: number;
  /** True when there was not enough history to say anything. An honest "not yet", not a failure. */
  tooLittleData: boolean;
}

export class RecommenderRepository {
  constructor(private readonly db: Queryable) {}

  /**
   * Every (customer, item) a business's food orders contain.
   *
   * Cancelled orders are excluded: a customer who cancelled did not choose
   * that item alongside anything, and counting it would recommend food
   * somebody sent back.
   *
   * Keyed on the contact where one resolved and the phone number otherwise,
   * because a regular who has never been matched to a contact row is still
   * the same person across two orders - and losing them would throw away
   * exactly the repeat custom this is built to find.
   */
  async foodInteractions(businessId: string): Promise<CustomerItem[]> {
    const { rows } = await this.db.query<{ customer_key: string; item_key: string; label: string }>(
      `SELECT DISTINCT
         COALESCE(o.customer_contact_id::text, o.customer_phone) AS customer_key,
         COALESCE(line->>'menuItemId', lower(btrim(line->>'name'))) AS item_key,
         line->>'name' AS label
       FROM food_orders o
       CROSS JOIN LATERAL jsonb_array_elements(o.items) AS line
       WHERE o.business_id = $1
         AND o.stage <> 'CANCELLED'
         AND COALESCE(o.customer_contact_id::text, o.customer_phone) IS NOT NULL
         AND btrim(COALESCE(line->>'name', '')) <> ''`,
      [businessId],
    );
    return rows.map((row) => ({ customerKey: row.customer_key, itemKey: row.item_key, label: row.label }));
  }

  /** The same, over retail orders. Same reasoning throughout. */
  async retailInteractions(businessId: string): Promise<CustomerItem[]> {
    const { rows } = await this.db.query<{ customer_key: string; item_key: string; label: string }>(
      `SELECT DISTINCT
         o.customer_contact_id::text AS customer_key,
         COALESCE(line->>'productId', lower(btrim(line->>'name'))) AS item_key,
         line->>'name' AS label
       FROM retail_orders o
       CROSS JOIN LATERAL jsonb_array_elements(o.items) AS line
       WHERE o.business_id = $1
         /* Only orders somebody actually stood behind. A retail order sits
            in PENDING_APPROVAL until a person approves it, and counting
            unapproved ones would learn from suggestions the business
            rejected. */
         AND o.status IN ('APPROVED', 'FULFILLED')
         AND o.customer_contact_id IS NOT NULL
         AND btrim(COALESCE(line->>'name', '')) <> ''`,
      [businessId],
    );
    return rows.map((row) => ({ customerKey: row.customer_key, itemKey: row.item_key, label: row.label }));
  }

  /**
   * Property, where there is no basket at all.
   *
   * A reservation is against one PROPERTY, so the only co-occurrence
   * available is a guest who stayed at two different properties over time -
   * "guests who stayed at the Beach Villa also stayed at the Ridge House".
   * Precisely why co-occurrence is counted per customer rather than per
   * transaction: a basket model returns nothing at all here.
   *
   * A guest with no contact row is skipped rather than keyed on something
   * else. Unlike a food order there is no phone number on a reservation to
   * fall back to, and inventing a key would merge strangers into one
   * imaginary repeat guest.
   */
  async propertyInteractions(businessId: string): Promise<CustomerItem[]> {
    const { rows } = await this.db.query<{ customer_key: string; item_key: string; label: string }>(
      `SELECT DISTINCT
         r.guest_contact_id::text AS customer_key,
         r.property_id::text AS item_key,
         p.name AS label
       FROM property_reservations r
       JOIN property_properties p ON p.business_id = r.business_id AND p.id = r.property_id
       WHERE r.business_id = $1
         AND r.status <> 'CANCELLED'
         AND r.guest_contact_id IS NOT NULL`,
      [businessId],
    );
    return rows.map((row) => ({ customerKey: row.customer_key, itemKey: row.item_key, label: row.label }));
  }

  /**
   * Replaces a domain's pairs with a freshly counted set.
   *
   * Delete-then-insert inside one transaction rather than an upsert: a pair
   * that has STOPPED being true has to disappear, and an upsert leaves it
   * behind at its old score forever. A withdrawn dish would keep being
   * recommended for as long as the table lived.
   */
  async replacePairs(businessId: string, domain: RecommenderDomain, pairs: StoredPair[], stats: Omit<BuildOutcome, 'pairsStored' | 'domain'>): Promise<BuildOutcome> {
    await this.db.query('DELETE FROM recommender_item_pairs WHERE business_id = $1 AND domain = $2', [businessId, domain]);

    if (pairs.length > 0) {
      // One multi-row insert rather than a statement per pair: a forty-item
      // menu produces hundreds of pairs and a round trip each would make a
      // nightly rebuild take minutes instead of a second.
      const values: unknown[] = [businessId, domain];
      const tuples = pairs.map((pair, index) => {
        const base = index * 8 + 3;
        values.push(
          pair.itemA, pair.itemB, pair.itemALabel, pair.itemBLabel,
          pair.pairCustomers, pair.aCustomers, pair.bCustomers, pair.score.toFixed(5),
        );
        return `($1, $2, $${base}, $${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`;
      });

      await this.db.query(
        `INSERT INTO recommender_item_pairs
           (business_id, domain, item_a, item_b, item_a_label, item_b_label, pair_customers, a_customers, b_customers, score)
         VALUES ${tuples.join(', ')}`,
        values,
      );
    }

    const outcome: BuildOutcome = { domain, ...stats, pairsStored: pairs.length };

    await this.db.query(
      `INSERT INTO recommender_builds
         (business_id, domain, customers_considered, items_considered, pairs_stored, too_little_data, rebuilt_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (business_id, domain) DO UPDATE SET
         customers_considered = EXCLUDED.customers_considered,
         items_considered = EXCLUDED.items_considered,
         pairs_stored = EXCLUDED.pairs_stored,
         too_little_data = EXCLUDED.too_little_data,
         rebuilt_at = now()`,
      [businessId, domain, outcome.customersConsidered, outcome.itemsConsidered, outcome.pairsStored, outcome.tooLittleData],
    );

    return outcome;
  }

  /**
   * What goes with this item, strongest first.
   *
   * The evidence floor is applied in SQL as well as in the scorer. A caller
   * that forgot to filter would otherwise put a one-coincidence pair in
   * front of a customer, and the guard matters most exactly where it is
   * easiest to forget.
   */
  async companionsFor(
    businessId: string,
    domain: RecommenderDomain,
    itemKey: string,
    limit = 3,
  ): Promise<{ itemKey: string; label: string; score: number; pairCustomers: number; ofCustomers: number }[]> {
    const { rows } = await this.db.query<{
      item_key: string; label: string; score: string; pair_customers: number; of_customers: number;
    }>(
      `SELECT
         CASE WHEN item_a = $3 THEN item_b ELSE item_a END AS item_key,
         CASE WHEN item_a = $3 THEN item_b_label ELSE item_a_label END AS label,
         score,
         pair_customers,
         CASE WHEN item_a = $3 THEN a_customers ELSE b_customers END AS of_customers
       FROM recommender_item_pairs
       WHERE business_id = $1 AND domain = $2
         AND (item_a = $3 OR item_b = $3)
         AND pair_customers >= $4
         AND score >= $5
       ORDER BY score DESC, pair_customers DESC
       LIMIT $6`,
      [businessId, domain, itemKey, MIN_PAIR_CUSTOMERS, MIN_SCORE, limit],
    );

    return rows.map((row) => ({
      itemKey: row.item_key,
      label: row.label,
      score: Number(row.score),
      pairCustomers: row.pair_customers,
      ofCustomers: row.of_customers,
    }));
  }

  async lastBuild(businessId: string, domain: RecommenderDomain): Promise<BuildOutcome & { rebuiltAt: string } | null> {
    const { rows } = await this.db.query<{
      customers_considered: number; items_considered: number; pairs_stored: number;
      too_little_data: boolean; rebuilt_at: string;
    }>(
      'SELECT * FROM recommender_builds WHERE business_id = $1 AND domain = $2',
      [businessId, domain],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      domain,
      customersConsidered: row.customers_considered,
      itemsConsidered: row.items_considered,
      pairsStored: row.pairs_stored,
      tooLittleData: row.too_little_data,
      rebuiltAt: row.rebuilt_at,
    };
  }
}

/** Re-exported so a caller building pairs shares the one definition of the floor. */
export { MIN_PAIR_CUSTOMERS, MIN_SCORE, cosineScore };
