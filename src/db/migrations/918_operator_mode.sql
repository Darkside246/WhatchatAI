-- Operator Mode: lets the business owner WhatsApp their own account and execute
-- admin commands after PIN authentication. Sessions are short-lived and
-- scoped strictly to the authenticating business account.

-- Settings per business: the owner's personal WA JID + hashed PIN.
-- PIN is hashed server-side with scrypt (Node crypto built-in).
CREATE TABLE operator_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL UNIQUE REFERENCES businesses(id) ON DELETE CASCADE,

  -- The owner's personal WhatsApp JID (e.g. "1246XXXXXXX@s.whatsapp.net").
  -- Only messages from this JID can trigger operator mode.
  operator_wa_jid TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- scrypt-based PIN storage. Raw PIN never stored.
  pin_salt TEXT NOT NULL,    -- 32 hex bytes random salt
  pin_hash TEXT NOT NULL,    -- hex-encoded scrypt(PIN, salt)
  pin_n INT NOT NULL DEFAULT 16384,
  pin_r INT NOT NULL DEFAULT 8,
  pin_p INT NOT NULL DEFAULT 1,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Active operator sessions (one per business at a time).
-- status='AWAITING_PIN': challenge sent, waiting for PIN reply (2-min window).
-- status='AUTHENTICATED': PIN verified, commands accepted (30-min sliding window).
CREATE TABLE operator_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  wa_jid TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'AWAITING_PIN'
    CHECK (status IN ('AWAITING_PIN', 'AUTHENTICATED')),
  pin_attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  last_command_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active session per business at any time.
  UNIQUE (business_id)
);
