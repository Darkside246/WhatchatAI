CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  crm_contact_id UUID NOT NULL REFERENCES crm_contacts(id),

  source TEXT,
  stage TEXT,
  status TEXT NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW', 'QUALIFIED', 'ENGAGED', 'WON', 'LOST')),
  -- No FK: the Team/Permissions user table doesn't exist yet (Phase 17).
  owner_user_id UUID,
  score NUMERIC,
  value NUMERIC,
  last_activity_at TIMESTAMPTZ,
  next_action TEXT,
  notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX leads_crm_contact_idx ON leads (crm_contact_id);
CREATE INDEX leads_business_status_idx ON leads (business_id, status) WHERE deleted_at IS NULL;
