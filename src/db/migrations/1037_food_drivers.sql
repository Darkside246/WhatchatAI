-- Who has the food.
--
-- Once an order leaves the building it stops being a kitchen problem and
-- becomes a whereabouts problem. A board that says "out for delivery" and
-- nothing else cannot answer the only question anybody asks about it.
--
-- Deliberately NOT here: automatic dispatch, routing, batching, live
-- tracking. A dispatcher that assigns the wrong driver by itself is worse
-- than no dispatcher, and none of it is worth anything until a business is
-- reliably recording who took what by hand. Every assignment is a person
-- choosing a person.

CREATE TABLE IF NOT EXISTS food_drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  name TEXT NOT NULL,
  /* How the shop reaches them mid-run. Optional, because a business whose
     drivers are the two people standing in the kitchen does not need to
     type a number to use this. */
  phone_number TEXT,
  /* "Red Honda", "the blue van", "bike". What somebody says over a pass. */
  vehicle TEXT,
  notes TEXT,

  /* Left rather than deleted. A driver who stops working here still drove
     the deliveries they drove, and deleting them would rewrite that
     history - so they go inactive and drop off the picker instead. */
  active BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

/* One person, one row. Only among ACTIVE drivers: a name freed up by
   somebody leaving can be used again, and a returning driver gets a fresh
   record rather than inheriting an old one's history. */
CREATE UNIQUE INDEX IF NOT EXISTS food_drivers_name_idx
  ON food_drivers (business_id, lower(name))
  WHERE active = true;

CREATE TABLE IF NOT EXISTS food_order_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,
  driver_id UUID NOT NULL,

  state TEXT NOT NULL DEFAULT 'ASSIGNED'
    CHECK (state IN ('ASSIGNED', 'COLLECTED', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED')),

  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by UUID REFERENCES users(id) ON DELETE SET NULL,
  collected_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  /* Nobody in, wrong address, customer refused it. Required by the
     repository when a run fails, because "failed" on its own tells the
     next person nothing they can act on. */
  failure_reason TEXT,
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES food_orders (business_id, id) ON DELETE CASCADE,
  /* RESTRICT rather than CASCADE: deleting a driver must never quietly
     delete the record of the deliveries they made. The repository
     deactivates instead of deleting, and this is what makes that the only
     possible route. */
  FOREIGN KEY (business_id, driver_id) REFERENCES food_drivers (business_id, id) ON DELETE RESTRICT
);

/* ONE live assignment per order, enforced by the database rather than by a
   check-then-insert in application code. Two people assigning two drivers
   to the same order in the same moment is exactly what happens during a
   rush, and the second one has to lose. */
CREATE UNIQUE INDEX IF NOT EXISTS food_order_deliveries_live_idx
  ON food_order_deliveries (business_id, order_id)
  WHERE state IN ('ASSIGNED', 'COLLECTED', 'FAILED');

/* "What is this driver carrying right now" - the question asked of a
   driver's name, rather than of an order. */
CREATE INDEX IF NOT EXISTS food_order_deliveries_driver_idx
  ON food_order_deliveries (business_id, driver_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON food_drivers, food_order_deliveries TO whatchatai_tenant;

ALTER TABLE food_drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_order_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON food_drivers;
DROP POLICY IF EXISTS tenant_isolation ON food_order_deliveries;

CREATE POLICY tenant_isolation ON food_drivers
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_order_deliveries
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
