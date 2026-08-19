CREATE TABLE whatsapp_message_reactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),
  message_id UUID NOT NULL REFERENCES whatsapp_messages(id),

  reactor_jid TEXT NOT NULL,
  reaction TEXT NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active reaction per person per message; WhatsApp reaction updates/removals
-- overwrite the same row rather than accumulating history.
CREATE UNIQUE INDEX whatsapp_message_reactions_identity_idx
  ON whatsapp_message_reactions (message_id, reactor_jid);
