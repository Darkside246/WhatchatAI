CREATE TABLE whatsapp_jid_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  lid_jid TEXT NOT NULL,
  phone_jid TEXT,
  phone_number TEXT,

  -- Provenance of the mapping. 'baileys_alt_jid' means it came from Baileys'
  -- own key.remoteJidAlt - the only source this app currently trusts to link
  -- a @lid identity to a phone number. Never invented.
  source TEXT NOT NULL CHECK (source IN ('baileys_alt_jid', 'manual', 'verified')),
  confidence TEXT NOT NULL DEFAULT 'high' CHECK (confidence IN ('high', 'medium', 'low')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX whatsapp_jid_mappings_identity_idx
  ON whatsapp_jid_mappings (business_id, whatsapp_account_id, lid_jid);
