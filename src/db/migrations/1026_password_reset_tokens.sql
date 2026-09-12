-- One-time tokens for resetting a forgotten password.
--
-- THE GAP. AURA had no way back in for someone who forgot their password.
-- An operator ran a script on the server, and until they did, that person
-- was locked out. For a product people sign into from their phone, that is
-- not a gap so much as an absence.
--
-- THE TOKEN IS NOT STORED. Only its SHA-256 hash is. A reset token is a
-- bearer credential - whoever holds it can take the account - so a database
-- dump, a leaked backup or a curious operator reading the table must not be
-- enough to use one. The same reasoning the sessions table already applies
-- to session tokens.
--
-- WHY A SEPARATE TABLE AND NOT A COLUMN ON users. A person can legitimately
-- ask twice (the first email is slow, they click again), and each request
-- needs its own expiry and its own single use. A column would hold one
-- token and quietly invalidate the earlier one the moment a second was
-- issued - which is the exact moment the first one arrives in their inbox.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- SHA-256 of the token, never the token. Unique so a lookup is an
  -- indexed equality match rather than a scan, and so two requests can
  -- never collide on the same secret.
  token_hash text NOT NULL UNIQUE,

  -- 'email' | 'whatsapp'. Recorded because the two are not equally strong -
  -- a link mailed to a verified address and a code read out over the
  -- business's own WhatsApp line are different assurances, and an
  -- investigation later needs to know which one let someone in.
  delivery_channel text NOT NULL,

  expires_at timestamptz NOT NULL,
  -- Set the moment it is spent. A reset token that works twice is a token
  -- that works for whoever reads the email second.
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT password_reset_tokens_channel_check
    CHECK (delivery_channel IN ('email', 'whatsapp'))
);

-- Supports the rate limit: "how many has this user asked for recently".
CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
  ON password_reset_tokens (user_id, created_at DESC);

-- No RLS. These rows are pre-authentication by definition - there is no
-- session and no tenant context to scope them to, and the only code that
-- reads them looks a single hash up directly.
