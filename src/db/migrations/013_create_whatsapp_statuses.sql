CREATE TABLE whatsapp_statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  status_id TEXT NOT NULL,
  publisher_jid TEXT NOT NULL,
  status_type TEXT NOT NULL CHECK (status_type IN ('text', 'image', 'video', 'audio', 'unknown')),

  text_content TEXT,
  media_id UUID REFERENCES whatsapp_media(id),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  view_count INTEGER,

  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE UNIQUE INDEX whatsapp_statuses_identity_idx
  ON whatsapp_statuses (business_id, whatsapp_account_id, status_id);
