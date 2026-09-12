-- How a business gets paid, and which of those ways it wants used.
--
-- Researched September 2026. BiMPay (the Central Bank of Barbados' instant
-- payment system, live June 2026) and CIBC 1stPay both work by a PERSON
-- creating a request in a bank's own app; neither publishes an interface a
-- vendor can call. So this schema stores what we genuinely need to help
-- with - the alias to pay, the wording the customer gets - and records
-- confirmation as the human act it actually is.
--
-- What is deliberately NOT here: any column that would let a business mark
-- a manual method as self-confirming. How confirmation arrives is a
-- property of the method (see paymentMethods.ts), not a setting, because a
-- kitchen gate opened by a confirmation nobody received is worse than no
-- gate.

CREATE TABLE IF NOT EXISTS food_payment_methods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,

  method TEXT NOT NULL
    CHECK (method IN ('CASH', 'BANK_TRANSFER', 'BIMPAY', 'ONE_STPAY', 'WIPAY', 'FAC', 'CARD_IN_PERSON', 'ON_ACCOUNT', 'OTHER')),

  enabled BOOLEAN NOT NULL DEFAULT false,
  /* The one offered first. At most one per business, enforced below. */
  preferred BOOLEAN NOT NULL DEFAULT false,

  /* What the customer pays TO - a BiMPay alias, a 1stPay email or mobile,
     account details. Never a credential: nothing secret goes in this
     column, because its whole purpose is to be read out to customers. */
  alias TEXT,
  /* The business's own wording, if our sentence does not suit them. */
  instructions TEXT,

  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, method),
  UNIQUE (business_id, id)
);

/* At most one preferred method, in the database rather than in a service
   that remembers to clear the old one. Two "preferred" rows is a screen
   that contradicts itself. */
CREATE UNIQUE INDEX IF NOT EXISTS food_payment_methods_preferred_idx
  ON food_payment_methods (business_id)
  WHERE preferred = true;

/* Asking a customer to pay, and what happened next.
   Separate from food_order_events because this is a money conversation
   with its own history: asked at 7:42, asked again at 8:10, confirmed by
   Ama at 8:15. An order's stage history cannot carry that without
   becoming unreadable. */
CREATE TABLE IF NOT EXISTS food_payment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  order_id UUID NOT NULL,

  method TEXT NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'BBD',

  /* The alias as it was at the time of asking. Copied rather than joined:
     a business that changes its BiMPay alias next month must not rewrite
     what a customer was told last week. */
  alias_at_request TEXT,
  /* Exactly what the customer was sent, for the same reason. */
  message_sent TEXT,
  /* The outbound WhatsApp message, when one went out. */
  outbound_message_id UUID,

  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by UUID REFERENCES users(id) ON DELETE SET NULL,

  /* Who said the money arrived, and when they said it. Null while nobody
     has. This is the act that opens the kitchen gate, so it is recorded
     against a person. */
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  /* A BiMPay reference, a transfer number, "she showed me the screen". */
  confirmation_reference TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, order_id) REFERENCES food_orders (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS food_payment_requests_order_idx
  ON food_payment_requests (business_id, order_id, requested_at DESC);

/* "Who have we asked and not been paid by" - the question a shop asks at
   closing time. */
CREATE INDEX IF NOT EXISTS food_payment_requests_outstanding_idx
  ON food_payment_requests (business_id, requested_at DESC)
  WHERE confirmed_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON food_payment_methods, food_payment_requests TO whatchatai_tenant;

ALTER TABLE food_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_payment_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON food_payment_methods;
DROP POLICY IF EXISTS tenant_isolation ON food_payment_requests;

CREATE POLICY tenant_isolation ON food_payment_methods
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_payment_requests
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
