CREATE TABLE whatsapp_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  group_jid TEXT NOT NULL,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT,

  owner_jid TEXT,
  creation_timestamp TIMESTAMPTZ,

  participants_count INTEGER NOT NULL DEFAULT 0,
  is_community BOOLEAN,
  is_announcement BOOLEAN,
  is_restricted BOOLEAN,

  profile_picture_url TEXT,

  source_type TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (source_type IN ('whatsapp', 'manual', 'google', 'crm', 'system')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX whatsapp_groups_identity_idx
  ON whatsapp_groups (business_id, whatsapp_account_id, group_jid)
  WHERE deleted_at IS NULL;
