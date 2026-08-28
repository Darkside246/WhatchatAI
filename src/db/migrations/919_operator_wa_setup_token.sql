-- One-time WhatsApp setup token for operator mode configuration.
-- The owner generates a code in the web UI, then sends
-- "setup operator [CODE]" to their business WhatsApp number.
-- The token is burned (deleted) after a successful first use.

CREATE TABLE operator_wa_setup_tokens (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,   -- scrypt hash of the plain-text token shown in the UI
  token_salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
