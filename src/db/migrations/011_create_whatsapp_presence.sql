CREATE TABLE whatsapp_presence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  contact_jid TEXT NOT NULL,
  presence_state TEXT NOT NULL
    CHECK (presence_state IN ('available', 'unavailable', 'composing', 'recording', 'paused', 'unknown')),
  last_seen_at TIMESTAMPTZ,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_presence_contact_idx
  ON whatsapp_presence (whatsapp_account_id, contact_jid, recorded_at DESC);
