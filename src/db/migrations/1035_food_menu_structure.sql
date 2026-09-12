-- Menu structure, the way a real menu is actually shaped.
--
-- The first version had a flat item list with a free-text category and a
-- per-item JSONB blob of modifiers. That is fine for six items and
-- miserable for forty: "extra cheese, +1.50" has to be retyped on every
-- burger, and changing the price means finding all of them.
--
-- So modifier groups become shared and attachable, the way every real POS
-- does it. Variations stay on the item, because a size and its price
-- belong to one dish - a "large" is not a thing shared between a pizza and
-- a coffee.
--
-- Additive and backward compatible. The existing modifiers JSONB keeps
-- working (see orderIntake.ts, which resolves attached groups first and
-- falls back to it), so no business's menu stops pricing the moment this
-- lands.

/* Categories as rows rather than a text column, for two reasons a free
   text field cannot do: an operator can ORDER them (starters before
   mains, which is the whole point of a menu) and RENAME one without
   orphaning every item that carried the old string. */
CREATE TABLE IF NOT EXISTS food_menu_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  /* Where it sits on the menu. Sparse on purpose - inserting between two
     categories should not renumber the whole menu. */
  sort_order INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS food_menu_categories_name_idx
  ON food_menu_categories (business_id, lower(name));

/* A set of choices offered on one or more items: "Add-ons", "Choose a
   sauce", "How would you like it cooked". */
CREATE TABLE IF NOT EXISTS food_modifier_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,

  /* How many of this group's options may be chosen. A sauce choice is
     exactly one; add-ons are any number. Stored so the ordering agent can
     be told the rule rather than guessing at it. */
  min_select INTEGER NOT NULL DEFAULT 0,
  /* Null means no limit. */
  max_select INTEGER,

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  CHECK (max_select IS NULL OR max_select >= min_select)
);

CREATE UNIQUE INDEX IF NOT EXISTS food_modifier_groups_name_idx
  ON food_modifier_groups (business_id, lower(name));

CREATE TABLE IF NOT EXISTS food_modifier_options (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  group_id UUID NOT NULL,

  name TEXT NOT NULL,
  /* What it adds. Zero is normal and common - "no onions" costs nothing,
     and a sauce choice usually costs nothing either. */
  price_delta_cents BIGINT NOT NULL DEFAULT 0,
  /* The same one-tap out-of-stock an item has. A kitchen runs out of
     bacon, not just of burgers. */
  available BOOLEAN NOT NULL DEFAULT true,
  sort_order INTEGER NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, group_id) REFERENCES food_modifier_groups (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS food_modifier_options_group_idx
  ON food_modifier_options (business_id, group_id, sort_order);

/* Which groups an item offers. The join is the point of the whole
   change: one "Add-ons" group, attached to every burger. */
CREATE TABLE IF NOT EXISTS food_menu_item_modifier_groups (
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  menu_item_id UUID NOT NULL,
  group_id UUID NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,

  PRIMARY KEY (business_id, menu_item_id, group_id),
  FOREIGN KEY (business_id, menu_item_id) REFERENCES food_menu_items (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, group_id) REFERENCES food_modifier_groups (business_id, id) ON DELETE CASCADE
);

/* The item's own category, alongside the legacy text column rather than
   replacing it - nothing that reads `category` breaks, and the backfill
   below means both agree from day one. */
ALTER TABLE food_menu_items
  ADD COLUMN IF NOT EXISTS category_id UUID,
  /* Where it sits within its category. */
  ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE food_menu_items
  DROP CONSTRAINT IF EXISTS food_menu_items_category_fk;
/* SET NULL on category_id ONLY, named explicitly.
   A composite foreign key's plain ON DELETE SET NULL nulls every
   referencing column - including business_id, which is NOT NULL, so
   deleting a category failed outright. Naming the column keeps the
   composite key (which is what makes a cross-tenant category reference
   impossible) while nulling only the half that should go. */
ALTER TABLE food_menu_items
  ADD CONSTRAINT food_menu_items_category_fk
  FOREIGN KEY (business_id, category_id) REFERENCES food_menu_categories (business_id, id)
  ON DELETE SET NULL (category_id);

/* Turns every category string a business already uses into a real row, and
   points its items at it. Runs once; the ON CONFLICT makes a re-run a
   no-op rather than a duplicate. */
INSERT INTO food_menu_categories (business_id, name)
SELECT DISTINCT business_id, category FROM food_menu_items
WHERE category IS NOT NULL AND btrim(category) <> ''
ON CONFLICT DO NOTHING;

UPDATE food_menu_items AS item
SET category_id = category.id
FROM food_menu_categories AS category
WHERE category.business_id = item.business_id
  AND lower(category.name) = lower(item.category)
  AND item.category_id IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  food_menu_categories, food_modifier_groups, food_modifier_options, food_menu_item_modifier_groups
  TO whatchatai_tenant;

ALTER TABLE food_menu_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_modifier_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_modifier_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_menu_item_modifier_groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON food_menu_categories;
DROP POLICY IF EXISTS tenant_isolation ON food_modifier_groups;
DROP POLICY IF EXISTS tenant_isolation ON food_modifier_options;
DROP POLICY IF EXISTS tenant_isolation ON food_menu_item_modifier_groups;

CREATE POLICY tenant_isolation ON food_menu_categories USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_modifier_groups USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_modifier_options USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_menu_item_modifier_groups USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
