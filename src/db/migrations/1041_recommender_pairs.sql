-- "People who bought this also bought that", stored as counts.
--
-- Co-occurrence is counted over CUSTOMERS rather than over orders. Food and
-- retail have baskets; property does not - a reservation is one unit, and
-- two units only relate through the same customer booking both. Counting by
-- customer makes one model serve all three instead of two plus an excuse.
--
-- Recomputed in full rather than updated incrementally. A nightly rebuild
-- over a business's own orders is cheap at this scale, and an incremental
-- counter that drifts is worse than a slower one that cannot: a similarity
-- table nobody trusts gets switched off, and nobody can tell by looking
-- whether an incremental count is right.

CREATE TABLE IF NOT EXISTS recommender_item_pairs (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  /* Which vertical's catalogue these keys belong to. Pairs never cross
     domains: a menu item and a rental unit have nothing to say about each
     other, and letting them mix would produce suggestions that read as a
     bug. */
  domain TEXT NOT NULL CHECK (domain IN ('food', 'retail', 'property')),

  /* Catalogue ids, stored with the LOWER one first so a pair exists once
     rather than twice. Symmetric data stored twice is data that disagrees
     with itself eventually. */
  item_a TEXT NOT NULL,
  item_b TEXT NOT NULL,
  /* What to actually say. Copied at rebuild rather than joined, so a
     recommendation can still be phrased after an item is renamed or
     withdrawn - and so reading suggestions never needs three joins. */
  item_a_label TEXT NOT NULL,
  item_b_label TEXT NOT NULL,

  /* Distinct customers who took both, and who took each at all. Kept
     alongside the score so a suggestion can be explained in a sentence an
     owner is able to check. */
  pair_customers INTEGER NOT NULL,
  a_customers INTEGER NOT NULL,
  b_customers INTEGER NOT NULL,
  /* Cosine: pair / sqrt(a * b). Stored so reading is a sort, not a
     computation over every row. */
  score NUMERIC(6,5) NOT NULL,

  rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  PRIMARY KEY (business_id, domain, item_a, item_b),
  CHECK (item_a < item_b)
);

/* The only read this table exists for: "what goes with this item". Both
   ends are indexed because a pair is stored once and can be asked about
   from either side. */
CREATE INDEX IF NOT EXISTS recommender_item_pairs_a_idx
  ON recommender_item_pairs (business_id, domain, item_a, score DESC);
CREATE INDEX IF NOT EXISTS recommender_item_pairs_b_idx
  ON recommender_item_pairs (business_id, domain, item_b, score DESC);

/* When each business's table was last rebuilt, and what it was built from.
   Separate from the pairs so "is this stale" and "is there any signal yet"
   are answerable without scanning them - and so a business with too little
   data has somewhere to record that fact rather than just having no rows,
   which is indistinguishable from never having run. */
CREATE TABLE IF NOT EXISTS recommender_builds (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  domain TEXT NOT NULL CHECK (domain IN ('food', 'retail', 'property')),

  customers_considered INTEGER NOT NULL DEFAULT 0,
  items_considered INTEGER NOT NULL DEFAULT 0,
  pairs_stored INTEGER NOT NULL DEFAULT 0,
  /* True when there was simply not enough history to say anything. An
     honest empty is different from a failure, and the screen should say
     "not yet" rather than "none". */
  too_little_data BOOLEAN NOT NULL DEFAULT false,

  rebuilt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, domain)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON recommender_item_pairs, recommender_builds TO whatchatai_tenant;

ALTER TABLE recommender_item_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE recommender_builds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON recommender_item_pairs;
DROP POLICY IF EXISTS tenant_isolation ON recommender_builds;

CREATE POLICY tenant_isolation ON recommender_item_pairs
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON recommender_builds
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
