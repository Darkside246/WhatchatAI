CREATE TABLE whatsapp_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),
  group_id UUID NOT NULL REFERENCES whatsapp_groups(id),

  participant_jid TEXT NOT NULL,
  participant_phone_number TEXT,
  participant_contact_id UUID REFERENCES whatsapp_contacts(id),

  role TEXT NOT NULL DEFAULT 'member'
    CHECK (role IN ('member', 'admin', 'superadmin')),
  is_admin BOOLEAN NOT NULL DEFAULT false,
  is_super_admin BOOLEAN,

  joined_at TIMESTAMPTZ,
  left_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One membership row per participant per group; leaving/rejoining updates
-- left_at/joined_at in place rather than creating duplicate rows.
CREATE UNIQUE INDEX whatsapp_group_members_identity_idx
  ON whatsapp_group_members (group_id, participant_jid);
