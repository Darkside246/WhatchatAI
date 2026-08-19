CREATE TABLE subscription_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  subscription_id UUID NOT NULL REFERENCES subscriptions(id),

  event_type TEXT NOT NULL,
  previous_status TEXT,
  new_status TEXT,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX subscription_events_subscription_idx
  ON subscription_events (subscription_id, occurred_at DESC);
