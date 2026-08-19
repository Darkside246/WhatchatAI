CREATE TABLE plan_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID NOT NULL REFERENCES plans(id),

  entitlement_key TEXT NOT NULL,
  -- NULL means unlimited for this plan; a number is the real cap.
  limit_value NUMERIC,
  is_enabled BOOLEAN NOT NULL DEFAULT true,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX plan_entitlements_identity_idx ON plan_entitlements (plan_id, entitlement_key);
