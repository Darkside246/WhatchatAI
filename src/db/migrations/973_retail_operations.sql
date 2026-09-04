-- Retail Operations domain schema. Mirrors property_operations' tenant-
-- scoping conventions (composite (business_id, id) FKs, RLS, a shared
-- touch-updated-at trigger) but with a flat product catalog instead of a
-- property/unit/asset hierarchy, and a single retail_orders table instead
-- of a separate incident/work-order pair - a retail order's line items are
-- always created, read, and approved atomically with the order, never
-- queried independently, so they live as JSONB on the order row rather than
-- a separate table.

CREATE TABLE IF NOT EXISTS retail_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT,
  category TEXT NOT NULL DEFAULT 'GENERAL',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  price_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  stock_quantity INTEGER,
  description TEXT,
  image_url TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS retail_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  customer_contact_id UUID,
  source_channel TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  total_cents BIGINT NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'USD',
  fulfillment_method TEXT NOT NULL DEFAULT 'PICKUP',
  delivery_address TEXT,
  notes TEXT,
  ai_summary TEXT,
  confidence NUMERIC(5,4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fulfilled_at TIMESTAMPTZ,
  UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS retail_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  note TEXT NOT NULL,
  created_by_jid TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  FOREIGN KEY (business_id, product_id) REFERENCES retail_products (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS retail_triage_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  action_request_id UUID,
  message_text TEXT NOT NULL,
  ai_category TEXT NOT NULL,
  ai_urgency TEXT NOT NULL,
  ai_confidence NUMERIC(5,4) NOT NULL,
  human_decision TEXT NOT NULL,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_retail_products_business ON retail_products (business_id, status);
CREATE INDEX IF NOT EXISTS idx_retail_orders_business_status ON retail_orders (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retail_notes_business_product ON retail_notes (business_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_retail_triage_feedback_business ON retail_triage_feedback (business_id, created_at DESC);

CREATE OR REPLACE FUNCTION retail_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_retail_products_updated_at ON retail_products;
CREATE TRIGGER trg_retail_products_updated_at BEFORE UPDATE ON retail_products FOR EACH ROW EXECUTE FUNCTION retail_touch_updated_at();
DROP TRIGGER IF EXISTS trg_retail_orders_updated_at ON retail_orders;
CREATE TRIGGER trg_retail_orders_updated_at BEFORE UPDATE ON retail_orders FOR EACH ROW EXECUTE FUNCTION retail_touch_updated_at();

-- RLS, inline (this is a brand-new set of tables, unlike migration 958
-- which retrofitted tables that predated the RLS backstop).
GRANT SELECT, INSERT, UPDATE, DELETE ON retail_products, retail_orders, retail_notes, retail_triage_feedback TO whatchatai_tenant;
ALTER TABLE retail_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_triage_feedback ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON retail_products USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON retail_orders USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON retail_notes USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON retail_triage_feedback USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- Agent template - instruction and recommended_tools shipped together from
-- day one (property's own template drifted out of sync with its tools
-- across three separate migrations, 951->953->972; this ships once).
INSERT INTO agent_templates (template_key, name, role, description, category, default_tone, default_system_instruction, default_greeting, default_trigger_keywords, recommended_tools)
VALUES (
  'retail_operations_assistant',
  'Retail Assistant',
  'Retail Operations Assistant',
  'Helps customers browse products, place orders, and check order status.',
  'commerce',
  'friendly',
  'You are the Retail Operations Assistant for this business. You handle customer communication over WhatsApp: answering questions about products, availability, and pricing, and checking on the real status of an order someone already placed using your order-status tool - never guess or invent a status. You cannot place, modify, or cancel an order yourself and do not have access to payment or account records - a new order request is handled by the separate order-intake pipeline, not by any tool you have; if someone wants to place, change, or cancel an order, let them know it is being handled or that a team member will follow up, rather than guessing or inventing an answer.',
  'Hi! Thanks for reaching out — what can I help you find today?',
  '["order","buy","price","stock","delivery","pickup"]',
  '["get_current_time","update_conversation_memory","list_retail_products","check_retail_order_status"]'
);
