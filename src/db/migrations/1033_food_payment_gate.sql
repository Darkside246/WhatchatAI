-- Phase 1 of the food vertical: nothing reaches the kitchen unpaid.
--
-- A kitchen that cooks before payment clears is a kitchen giving away
-- food. So payment becomes the gate on the one handover that costs real
-- money - a taken order becoming a pan on a hob - rather than a status
-- sitting harmlessly beside the order.
--
-- Payment is its own state machine, kept separate from the kitchen's. The
-- two questions are genuinely independent: an order can be paid and not
-- started, started and refunded, delivered and still waiting on a transfer
-- to land. One status field cannot describe that without lying. They are
-- tied together at exactly one point - see domain/food/paymentGate.ts.
--
-- Additive only. No existing core table is touched.

/* Per-business food settings.
   One row per business, created on first read, so an operator who has
   never opened the settings page still gets defensible defaults. */
CREATE TABLE IF NOT EXISTS food_settings (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,

  /* The gate. ON by default: a business that has not thought about this
     yet is better protected by waiting for money than by cooking on
     trust, and turning it off is a deliberate, informed choice. */
  payment_required_before_kitchen BOOLEAN NOT NULL DEFAULT true,

  /* Dine-in, off by default. Most food businesses taking WhatsApp orders
     are takeaway and delivery; a table-number field on a food truck's
     order screen is clutter. Built, shipped, and switched off until asked
     for. */
  table_service_enabled BOOLEAN NOT NULL DEFAULT false,

  /* What the customer is told at order time when payment gates the
     kitchen. Editable because it is the operator's voice and their
     commercial policy, not ours. Null means use the shipped default. */
  payment_required_notice TEXT,

  /* The kitchen's own clock, where a business cooks to different times
     than the defaults in domain/food/orderLifecycle.ts. Null means use
     those. A bakery's custom cake and a burger have nothing in common. */
  sla_warning_seconds INTEGER,
  sla_breach_seconds INTEGER,

  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL
);

/* Customers this business will cook for before being paid.
   The known face, the office that orders every Friday, the regular who
   settles at the door. Keyed on the contact rather than a phone string so
   it follows the person as their identity resolves.
   Deliberately a standing PERMISSION, not a payment: an order released on
   these terms is WAIVED, never PAID, because the money is still owed and
   the one record an owner reconciles against must not say otherwise. */
CREATE TABLE IF NOT EXISTS food_customer_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  /* The WhatsApp contact. Nullable with phone as the fallback, because an
     operator may want to extend terms to a number before a contact row
     for it has synced. */
  contact_id UUID,
  phone_number TEXT,

  allow_pay_on_delivery BOOLEAN NOT NULL DEFAULT true,
  /* Why, in the operator's words - "shop next door, settles weekly".
     An unexplained standing exemption is one nobody can review later. */
  note TEXT,

  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,

  CHECK (contact_id IS NOT NULL OR phone_number IS NOT NULL)
);

/* One live set of terms per person. A partial index rather than a plain
   unique constraint so a revoked grant can sit in the table as history
   without blocking a new one. */
CREATE UNIQUE INDEX IF NOT EXISTS food_customer_terms_contact_idx
  ON food_customer_terms (business_id, contact_id) WHERE revoked_at IS NULL AND contact_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS food_customer_terms_phone_idx
  ON food_customer_terms (business_id, phone_number) WHERE revoked_at IS NULL AND phone_number IS NOT NULL;

ALTER TABLE food_orders
  ADD COLUMN IF NOT EXISTS payment_state TEXT NOT NULL DEFAULT 'UNPAID',
  ADD COLUMN IF NOT EXISTS payment_method TEXT,
  /* The provider's or bank's own reference. What an owner reconciles
     against, so it is stored verbatim and never generated here. */
  ADD COLUMN IF NOT EXISTS payment_reference TEXT,
  ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
  /* Why an order was cooked without payment, and on whose authority.
     Never inferred - an unattributable exemption is indistinguishable
     from a mistake. */
  ADD COLUMN IF NOT EXISTS payment_waiver_kind TEXT,
  ADD COLUMN IF NOT EXISTS payment_waiver_reason TEXT,
  ADD COLUMN IF NOT EXISTS payment_waived_by UUID REFERENCES users(id) ON DELETE SET NULL,
  /* The table, when dine-in is switched on. A label rather than a number:
     real rooms have "T4", "bar 2", "terrace". */
  ADD COLUMN IF NOT EXISTS table_label TEXT,
  /* One customer action must not produce two tickets. Derived from the
     confirming message, so a repeated webhook, a double tap on confirm,
     or a worker retry all resolve to the same order. */
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

ALTER TABLE food_orders
  DROP CONSTRAINT IF EXISTS food_orders_payment_state_check;
ALTER TABLE food_orders
  ADD CONSTRAINT food_orders_payment_state_check
  CHECK (payment_state IN ('NOT_REQUIRED', 'UNPAID', 'AWAITING_VERIFICATION', 'PAID', 'WAIVED', 'REFUNDED', 'FAILED'));

ALTER TABLE food_orders
  DROP CONSTRAINT IF EXISTS food_orders_payment_waiver_kind_check;
ALTER TABLE food_orders
  ADD CONSTRAINT food_orders_payment_waiver_kind_check
  CHECK (payment_waiver_kind IS NULL OR payment_waiver_kind IN ('customer_terms', 'manual'));

/* Dine-in joins collection and delivery as a fulfilment mode. */
ALTER TABLE food_orders
  DROP CONSTRAINT IF EXISTS food_orders_fulfilment_method_check;
ALTER TABLE food_orders
  ADD CONSTRAINT food_orders_fulfilment_method_check
  CHECK (fulfilment_method IN ('PICKUP', 'DELIVERY', 'DINE_IN'));

/* The idempotency guarantee itself. Partial, so the many orders keyed in
   by hand at a counter - which have no originating message and therefore
   no key - are not forced to collide on NULL. */
CREATE UNIQUE INDEX IF NOT EXISTS food_orders_idempotency_idx
  ON food_orders (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

/* The owner's real question during service: what is waiting on money. */
CREATE INDEX IF NOT EXISTS food_orders_payment_idx ON food_orders (business_id, payment_state, placed_at);

/* Every payment-state change, with who made it. The financial half of
   food_order_events, kept separate because the questions asked of it are
   different - reconciliation and dispute, not preparation time - and
   because a payment history that could be lost with a kitchen event log
   would be the wrong thing to lose. */
CREATE TABLE IF NOT EXISTS food_payment_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,

  from_state TEXT,
  to_state TEXT NOT NULL,
  method TEXT,
  /* Recorded in cents against the order's own currency, so a part payment
     or an adjustment is a real figure rather than a note. */
  amount_cents BIGINT,
  reference TEXT,

  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_kind TEXT NOT NULL DEFAULT 'user' CHECK (actor_kind IN ('user', 'ai', 'system', 'customer', 'provider')),
  note TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, order_id) REFERENCES food_orders (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS food_payment_events_order_idx ON food_payment_events (business_id, order_id, created_at);

-- Same tenant backstop as every other tenant-scoped table - see migration
-- 958 for why this binds only queryAsTenant()'s restricted role.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  food_settings, food_customer_terms, food_payment_events
  TO whatchatai_tenant;

ALTER TABLE food_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_customer_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_payment_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON food_settings;
DROP POLICY IF EXISTS tenant_isolation ON food_customer_terms;
DROP POLICY IF EXISTS tenant_isolation ON food_payment_events;

CREATE POLICY tenant_isolation ON food_settings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_customer_terms USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_payment_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
