CREATE TABLE business_unit_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  canonical TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, alias)
);

CREATE INDEX business_unit_aliases_business_idx ON business_unit_aliases (business_id);
