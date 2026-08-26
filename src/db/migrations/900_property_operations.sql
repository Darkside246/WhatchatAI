-- Property Operations domain schema. Kept separate from WhatsApp tables so the
-- property module can evolve without coupling its model to transport details.
-- Every row is tenant-scoped by business_id and all business-scoped references
-- are checked with composite foreign keys where applicable.

CREATE TABLE IF NOT EXISTS property_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  property_type TEXT NOT NULL DEFAULT 'VILLA',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  address_line_1 TEXT,
  address_line_2 TEXT,
  city TEXT,
  country_code TEXT,
  timezone TEXT,
  guest_instructions TEXT,
  emergency_instructions TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS property_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id UUID NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, property_id) REFERENCES property_properties (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS property_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  manufacturer TEXT,
  model TEXT,
  serial_number TEXT,
  location TEXT,
  instructions TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, unit_id) REFERENCES property_units (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS property_vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  service_categories TEXT[] NOT NULL DEFAULT '{}',
  phone TEXT,
  whatsapp_address TEXT,
  email TEXT,
  emergency_available BOOLEAN NOT NULL DEFAULT FALSE,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS property_reservations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id UUID NOT NULL,
  guest_contact_id UUID,
  external_reference TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  check_in_at TIMESTAMPTZ,
  check_out_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, property_id) REFERENCES property_properties (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS property_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id UUID NOT NULL,
  unit_id UUID,
  asset_id UUID,
  reservation_id UUID,
  vendor_id UUID,
  reported_by_contact_id UUID,
  source_channel TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'UNKNOWN',
  status TEXT NOT NULL DEFAULT 'OPEN',
  confidence NUMERIC(5,4),
  ai_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, property_id) REFERENCES property_properties (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, unit_id) REFERENCES property_units (business_id, id) ON DELETE SET NULL,
  FOREIGN KEY (business_id, asset_id) REFERENCES property_assets (business_id, id) ON DELETE SET NULL,
  FOREIGN KEY (business_id, reservation_id) REFERENCES property_reservations (business_id, id) ON DELETE SET NULL,
  FOREIGN KEY (business_id, vendor_id) REFERENCES property_vendors (business_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS property_work_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  incident_id UUID NOT NULL,
  vendor_id UUID,
  status TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  scheduled_for TIMESTAMPTZ,
  estimated_cost_cents BIGINT,
  approved_cost_cents BIGINT,
  description TEXT NOT NULL,
  completion_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, incident_id) REFERENCES property_incidents (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, vendor_id) REFERENCES property_vendors (business_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS property_knowledge_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id UUID,
  unit_id UUID,
  asset_id UUID,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'OPERATOR',
  source_reference TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, property_id) REFERENCES property_properties (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, unit_id) REFERENCES property_units (business_id, id) ON DELETE CASCADE,
  FOREIGN KEY (business_id, asset_id) REFERENCES property_assets (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS property_safety_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  property_id UUID,
  name TEXT NOT NULL,
  policy_type TEXT NOT NULL,
  rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, property_id) REFERENCES property_properties (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_property_properties_business ON property_properties (business_id);
CREATE INDEX IF NOT EXISTS idx_property_units_business_property ON property_units (business_id, property_id);
CREATE INDEX IF NOT EXISTS idx_property_assets_business_unit ON property_assets (business_id, unit_id);
CREATE INDEX IF NOT EXISTS idx_property_vendors_business_active ON property_vendors (business_id, active);
CREATE INDEX IF NOT EXISTS idx_property_incidents_business_status ON property_incidents (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_incidents_business_property ON property_incidents (business_id, property_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_work_orders_business_status ON property_work_orders (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_knowledge_business_property ON property_knowledge_items (business_id, property_id, active);

CREATE OR REPLACE FUNCTION property_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_property_properties_updated_at ON property_properties;
CREATE TRIGGER trg_property_properties_updated_at BEFORE UPDATE ON property_properties FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_units_updated_at ON property_units;
CREATE TRIGGER trg_property_units_updated_at BEFORE UPDATE ON property_units FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_assets_updated_at ON property_assets;
CREATE TRIGGER trg_property_assets_updated_at BEFORE UPDATE ON property_assets FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_vendors_updated_at ON property_vendors;
CREATE TRIGGER trg_property_vendors_updated_at BEFORE UPDATE ON property_vendors FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_reservations_updated_at ON property_reservations;
CREATE TRIGGER trg_property_reservations_updated_at BEFORE UPDATE ON property_reservations FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_incidents_updated_at ON property_incidents;
CREATE TRIGGER trg_property_incidents_updated_at BEFORE UPDATE ON property_incidents FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_work_orders_updated_at ON property_work_orders;
CREATE TRIGGER trg_property_work_orders_updated_at BEFORE UPDATE ON property_work_orders FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_knowledge_items_updated_at ON property_knowledge_items;
CREATE TRIGGER trg_property_knowledge_items_updated_at BEFORE UPDATE ON property_knowledge_items FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
DROP TRIGGER IF EXISTS trg_property_safety_policies_updated_at ON property_safety_policies;
CREATE TRIGGER trg_property_safety_policies_updated_at BEFORE UPDATE ON property_safety_policies FOR EACH ROW EXECUTE FUNCTION property_touch_updated_at();
