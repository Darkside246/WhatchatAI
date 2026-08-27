CREATE TABLE product_account_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_account_id UUID NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES product_catalog(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED')),
  currency TEXT NOT NULL DEFAULT 'BBD',
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  billing_interval TEXT NOT NULL DEFAULT 'month' CHECK (billing_interval IN ('month', 'year', 'one_time')),
  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  activated_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX product_account_one_active_subscription
  ON product_account_subscriptions(product_account_id)
  WHERE status IN ('PENDING_PAYMENT', 'ACTIVE', 'PAST_DUE');

CREATE TABLE payment_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_account_id UUID NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES product_account_subscriptions(id) ON DELETE SET NULL,
  provider TEXT NOT NULL CHECK (provider IN ('BIMPAY', 'BANK_TRANSFER', 'OTHER')),
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RECEIVED', 'VERIFIED', 'REJECTED', 'EXPIRED', 'REFUNDED')),
  currency TEXT NOT NULL DEFAULT 'BBD',
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  checkout_reference TEXT NOT NULL UNIQUE,
  external_reference TEXT,
  provider_event_id TEXT,
  received_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX payment_attempt_provider_event_unique
  ON payment_attempts(provider, provider_event_id)
  WHERE provider_event_id IS NOT NULL;
CREATE INDEX payment_attempts_account_status_idx ON payment_attempts(product_account_id, status);

CREATE TABLE payment_proof_submissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_attempt_id UUID NOT NULL REFERENCES payment_attempts(id) ON DELETE CASCADE,
  product_account_id UUID NOT NULL REFERENCES product_accounts(id) ON DELETE CASCADE,
  submitted_by_user_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED')) DEFAULT 'PENDING_REVIEW',
  proof_url TEXT NOT NULL,
  note TEXT,
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_proof_submissions_status_idx ON payment_proof_submissions(status, created_at);

CREATE TABLE payment_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_account_id UUID REFERENCES product_accounts(id) ON DELETE SET NULL,
  payment_attempt_id UUID REFERENCES payment_attempts(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('SYSTEM', 'CLIENT', 'DEVELOPER', 'PROVIDER_BRIDGE')),
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX payment_audit_events_account_idx ON payment_audit_events(product_account_id, created_at DESC);

ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS default_currency TEXT NOT NULL DEFAULT 'BBD';
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS monthly_price_minor BIGINT;
ALTER TABLE product_catalog ADD COLUMN IF NOT EXISTS annual_price_minor BIGINT;
