-- Trial identity and lifecycle foundation.
-- One normalized email identity can receive exactly one trial, regardless of product.

CREATE TABLE trial_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE product_trials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trial_identity_id UUID NOT NULL UNIQUE REFERENCES trial_identities(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES product_catalog(id),
  product_account_id UUID REFERENCES product_accounts(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'CREATED'
    CHECK (state IN ('CREATED', 'ACTIVE', 'EXPIRING', 'EXPIRED', 'CONVERTED', 'CANCELLED')),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at),
  CHECK ((state IN ('ACTIVE', 'EXPIRING', 'EXPIRED', 'CONVERTED') AND starts_at IS NOT NULL AND ends_at IS NOT NULL)
      OR state IN ('CREATED', 'CANCELLED'))
);

CREATE INDEX idx_product_trials_state_ends_at ON product_trials (state, ends_at);
CREATE INDEX idx_product_trials_account ON product_trials (product_account_id);
