-- Bootstrap tenant table. WhatchatAI's Authentication + Multi-Tenant phase has not
-- been built yet, but every WhatsApp record below is tenant-scoped by business_id
-- per the Phase 2C data model, so a minimal real businesses table has to exist first.
CREATE TABLE businesses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
