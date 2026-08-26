CREATE TABLE IF NOT EXISTS property_conversation_bindings (
  business_id UUID NOT NULL,
  chat_id UUID NOT NULL,
  property_id UUID NOT NULL,
  unit_id UUID,
  reservation_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, chat_id),
  CONSTRAINT fk_property_binding_business FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  CONSTRAINT fk_property_binding_property FOREIGN KEY (business_id, property_id)
    REFERENCES property_properties (business_id, id) ON DELETE CASCADE,
  CONSTRAINT fk_property_binding_unit FOREIGN KEY (business_id, unit_id)
    REFERENCES property_units (business_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_property_bindings_property
  ON property_conversation_bindings (business_id, property_id);

CREATE OR REPLACE FUNCTION property_binding_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_property_binding_updated_at ON property_conversation_bindings;
CREATE TRIGGER trg_property_binding_updated_at
  BEFORE UPDATE ON property_conversation_bindings
  FOR EACH ROW EXECUTE FUNCTION property_binding_touch_updated_at();
