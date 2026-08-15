CREATE TABLE whatsapp_contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  whatsapp_jid TEXT NOT NULL,
  jid_kind TEXT NOT NULL
    CHECK (jid_kind IN ('individual', 'lid', 'group', 'broadcast', 'newsletter', 'unknown')),
  phone_number TEXT,

  display_name TEXT,
  push_name TEXT,
  verified_name TEXT,
  short_name TEXT,
  business_name TEXT,

  is_business BOOLEAN,
  is_contact BOOLEAN,

  profile_picture_url TEXT,
  about_text TEXT,

  presence_status TEXT
    CHECK (presence_status IS NULL OR presence_status IN (
      'available', 'unavailable', 'composing', 'recording', 'paused', 'unknown'
    )),
  presence_updated_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,

  source_type TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (source_type IN ('whatsapp', 'manual', 'google', 'crm', 'system')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Identity key: the same real-world contact is one row per account, keyed by the
-- JID exactly as WhatsApp gave it (never rewritten), not by display name.
CREATE UNIQUE INDEX whatsapp_contacts_identity_idx
  ON whatsapp_contacts (business_id, whatsapp_account_id, whatsapp_jid)
  WHERE deleted_at IS NULL;

CREATE INDEX whatsapp_contacts_phone_idx
  ON whatsapp_contacts (business_id, whatsapp_account_id, phone_number)
  WHERE phone_number IS NOT NULL AND deleted_at IS NULL;
