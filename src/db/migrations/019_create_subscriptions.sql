CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  plan_id UUID NOT NULL REFERENCES plans(id),

  status TEXT NOT NULL DEFAULT 'TRIALING'
    CHECK (status IN ('ACTIVE', 'TRIALING', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'EXPIRED')),

  current_period_start TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  trial_ends_at TIMESTAMPTZ,
  cancel_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,

  -- Abstracted behind SubscriptionRepository; no payment-provider-specific logic elsewhere.
  payment_provider TEXT,
  payment_customer_id TEXT,
  payment_subscription_id TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A business has at most one "live" subscription at a time; CANCELLED/EXPIRED rows
-- are kept as history rather than deleted.
CREATE UNIQUE INDEX subscriptions_one_live_per_business_idx
  ON subscriptions (business_id)
  WHERE status IN ('ACTIVE', 'TRIALING', 'PAST_DUE', 'PAUSED');
