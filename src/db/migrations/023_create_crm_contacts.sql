CREATE TABLE crm_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),

  -- The real identity link: a CRM profile is built around an actual WhatsApp
  -- contact/conversation, not a separately invented one. Nullable because a
  -- CRM record can also originate from a non-WhatsApp source (Phase 10+).
  whatsapp_contact_id UUID REFERENCES whatsapp_contacts(id),

  source TEXT,
  stage TEXT,
  lead_status TEXT,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  notes TEXT,
  -- No FK: the Team/Permissions user table doesn't exist yet (Phase 17).
  owner_user_id UUID,
  ai_summary TEXT,
  customer_value NUMERIC,
  follow_up_date TIMESTAMPTZ,
  custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- One CRM profile per real WhatsApp contact - a name change never creates a duplicate.
CREATE UNIQUE INDEX crm_contacts_whatsapp_contact_idx
  ON crm_contacts (business_id, whatsapp_contact_id)
  WHERE whatsapp_contact_id IS NOT NULL AND deleted_at IS NULL;
