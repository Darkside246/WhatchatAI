-- Food operations: the back of house.
--
-- The conversational half of ordering already existed (see
-- services/foodOrdering) but had nowhere to put an order once it was
-- captured, and the operations screen was a mock built on hardcoded
-- customers. This is the real thing: a menu the kitchen can mark out of
-- stock, orders that move through the line, and a per-stage event log so
-- preparation times are measured rather than estimated.
--
-- Tenant scoping follows property_operations/retail_operations exactly -
-- composite (business_id, id) uniqueness so child rows can carry a
-- composite FK that makes a cross-tenant reference impossible at the
-- database level, not merely unlikely in application code.

CREATE TABLE IF NOT EXISTS food_menu_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  /* The operator's own code for the item. Theirs, not ours - it has to
     match whatever they already say on the phone and write on a board. */
  sku TEXT,
  category TEXT NOT NULL DEFAULT 'GENERAL',
  description TEXT,

  price_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',

  /* The "86" toggle. A kitchen runs out of something mid-service and needs
     it gone from ordering within seconds - which is why this is a plain
     boolean on the item and not a stock count nobody has time to keep
     accurate during a rush. */
  available BOOLEAN NOT NULL DEFAULT true,

  /* What customers really call it: "lg pep", "pepperoni pizza", "a large
     pep". The parser matches against these, so an operator can fix a
     misread order by adding the words their own customers actually use
     rather than waiting on a code change. */
  aliases TEXT[] NOT NULL DEFAULT '{}',

  /* Size variants and modifiers as JSONB rather than their own tables:
     they are only ever read and written together with the item, never
     queried across items, and a kitchen editing a menu wants one save. */
  variants JSONB NOT NULL DEFAULT '[]'::jsonb,
  modifiers JSONB NOT NULL DEFAULT '[]'::jsonb,

  /* Which section of the line makes this - grill, fryer, cold, bar. Drives
     which station screen a ticket's items appear on. */
  station TEXT,

  /* Allergens declared by the operator, surfaced as a banner on the pass.
     Declared rather than inferred: guessing an allergen from an item name
     would be a guess about somebody's safety. */
  allergens TEXT[] NOT NULL DEFAULT '{}',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE INDEX IF NOT EXISTS food_menu_items_business_idx ON food_menu_items (business_id, available, category);

/* Human-readable order numbers, counted per business.
   A separate row rather than a global sequence so every restaurant counts
   from its own #1 - an operator reads these out to customers and over a
   pass, and a number in the millions because other tenants exist would be
   unusable. Incremented with a single atomic UPSERT, so two orders taken
   in the same instant cannot collide. */
CREATE TABLE IF NOT EXISTS food_order_numbers (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  next_number BIGINT NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS food_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  /* What the operator and the customer both call it. */
  order_number BIGINT NOT NULL,

  /* The conversation it came from. The operations board keeps the chat
     beside the order deliberately - the answer to "what did they actually
     say?" has to be one click away from the ticket, not in another
     section of the app. Nullable because an order can also be keyed in by
     hand at the counter. */
  chat_id UUID REFERENCES whatsapp_chats(id) ON DELETE SET NULL,
  customer_contact_id UUID,

  stage TEXT NOT NULL DEFAULT 'NEW'
    CHECK (stage IN ('NEW', 'IN_KITCHEN', 'QUALITY_CHECK', 'READY_FOR_PICKUP', 'OUT_FOR_DELIVERY', 'COMPLETED', 'CANCELLED')),
  fulfilment_method TEXT NOT NULL DEFAULT 'PICKUP' CHECK (fulfilment_method IN ('PICKUP', 'DELIVERY')),

  customer_name TEXT,
  customer_phone TEXT,

  /* Line items with their chosen variant, modifiers and the price that was
     actually charged - captured at order time, never recomputed from the
     menu later. A menu price changing next week must not silently rewrite
     what somebody paid today. */
  items JSONB NOT NULL DEFAULT '[]'::jsonb,

  subtotal_cents BIGINT NOT NULL DEFAULT 0,
  delivery_fee_cents BIGINT NOT NULL DEFAULT 0,
  tax_cents BIGINT NOT NULL DEFAULT 0,
  total_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',

  /* A dropped pin, when the customer shared one. Plain columns rather than
     PostGIS geometry: this ships without requiring an extension, and
     radius-based delivery zones answer "can we get there" perfectly well
     for a single-kitchen business. */
  delivery_latitude DOUBLE PRECISION,
  delivery_longitude DOUBLE PRECISION,
  delivery_address TEXT,
  delivery_notes TEXT,

  /* Allergies and preparation warnings, shown as a full-width banner on
     the pass. Free text because the real ones never fit a list. */
  allergen_notes TEXT,
  kitchen_notes TEXT,

  /* When the customer wants it, for a pre-order or a cake collection.
     Null means as soon as possible, which is most orders. */
  scheduled_for TIMESTAMPTZ,

  /* The SLA clock starts here - when the customer ordered, not when the
     kitchen accepted. See domain/food/orderLifecycle.ts. */
  placed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  /* Set once, when the order reaches COMPLETED or CANCELLED, so a finished
     ticket stops ageing in a history view. */
  closed_at TIMESTAMPTZ,
  cancel_reason TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  UNIQUE (business_id, order_number)
);

/* The board's own query: every order still somebody's job, oldest first,
   because the oldest ticket is the one closest to breaching. */
CREATE INDEX IF NOT EXISTS food_orders_board_idx ON food_orders (business_id, stage, placed_at);
CREATE INDEX IF NOT EXISTS food_orders_chat_idx ON food_orders (business_id, chat_id);

/* Every stage change, with who did it and when.
   An append-only log rather than timestamp columns on the order, because
   the questions worth asking are about real elapsed time per station -
   how long tickets sit on the pass, which station is the bottleneck at
   seven on a Friday - and a set of nullable columns cannot answer those
   once a ticket has been sent back to the line and bumped again. */
CREATE TABLE IF NOT EXISTS food_order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,

  from_stage TEXT,
  to_stage TEXT NOT NULL,

  /* The user who pressed it. Null when the move was automatic or made by
     the AI - which actor_kind then distinguishes, rather than leaving a
     null to be guessed at. */
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'ai', 'system', 'customer')),
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES food_orders (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS food_order_events_order_idx ON food_order_events (business_id, order_id, created_at);

/* Where this kitchen will deliver, and what it charges to get there.
   A centre and a radius rather than a polygon: it needs no PostGIS, an
   operator can set it without drawing anything, and for a business
   delivering from one address it answers the real question. Tiered by
   radius so a further drop can cost more. */
CREATE TABLE IF NOT EXISTS food_delivery_zones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  centre_latitude DOUBLE PRECISION NOT NULL,
  centre_longitude DOUBLE PRECISION NOT NULL,
  radius_metres INTEGER NOT NULL,
  fee_cents BIGINT NOT NULL DEFAULT 0,
  minimum_order_cents BIGINT NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

-- Same tenant backstop as every other tenant-scoped table - see migration
-- 958 for why this binds only queryAsTenant()'s restricted role.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  food_menu_items, food_orders, food_order_events, food_delivery_zones, food_order_numbers
  TO whatchatai_tenant;

ALTER TABLE food_menu_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_delivery_zones ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_order_numbers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON food_menu_items;
DROP POLICY IF EXISTS tenant_isolation ON food_orders;
DROP POLICY IF EXISTS tenant_isolation ON food_order_events;
DROP POLICY IF EXISTS tenant_isolation ON food_delivery_zones;
DROP POLICY IF EXISTS tenant_isolation ON food_order_numbers;

CREATE POLICY tenant_isolation ON food_menu_items USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_orders USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_order_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_delivery_zones USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_order_numbers USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
