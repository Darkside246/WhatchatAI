-- Product-account foundation.
-- A product account is a focused SaaS tenant: one business + one product.
-- The same user may own multiple product accounts, but each account keeps
-- its own business, WhatsApp connection, data, entitlements and billing boundary.

CREATE TABLE product_catalog (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO product_catalog (product_key, name, description) VALUES
  ('property', 'WhatsChat Property', 'Property operations, maintenance and tenant workflow automation.'),
  ('food', 'WhatsChat Food', 'WhatsApp-native ordering for restaurants, food trucks, takeaways and small food businesses.'),
  ('commerce', 'WhatsChat Commerce', 'Quotes, invoices, inventory and customer commerce workflows.'),
  ('scheduling', 'WhatsChat Scheduling', 'Appointments, pickup, delivery and technician scheduling.'),
  ('support', 'WhatsChat Support', 'Customer support and human handoff operations.')
ON CONFLICT (product_key) DO NOTHING;

CREATE TABLE product_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES product_catalog(id),
  owner_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'PROVISIONING'
    CHECK (status IN ('PROVISIONING', 'ACTIVE', 'RESTRICTED', 'SUSPENDED', 'CLOSED')),
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_user_id, product_id)
);

CREATE INDEX idx_product_accounts_product ON product_accounts (product_id);
CREATE INDEX idx_product_accounts_owner ON product_accounts (owner_user_id);
CREATE INDEX idx_product_accounts_status ON product_accounts (status);

CREATE TABLE product_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_account_id UUID NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
  entitlement_key TEXT NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  limit_value INTEGER,
  source TEXT NOT NULL DEFAULT 'PRODUCT'
    CHECK (source IN ('PRODUCT', 'PLAN', 'TRIAL', 'OVERRIDE')),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_account_id, entitlement_key)
);

CREATE INDEX idx_product_entitlements_account ON product_entitlements (product_account_id);

-- Product-level account isolation is enforced by the database relationship,
-- while application services must still scope every operational query by
-- product_account_id. This table records the provisioning boundary explicitly.
CREATE TABLE product_account_provisioning_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_account_id UUID NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('CREATED', 'PROVISIONED', 'RESTRICTED', 'REACTIVATED', 'SUSPENDED', 'CLOSED')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_product_account_provisioning_events_account_time
  ON product_account_provisioning_events (product_account_id, created_at DESC);
