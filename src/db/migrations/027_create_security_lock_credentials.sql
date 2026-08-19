-- Master PIN/passcode credential for the workspace screen lock. The PIN
-- itself is never stored - only an Argon2id digest computed from the PIN,
-- a server-issued salt, and fixed parameters (both client and server run the
-- same Argon2id implementation against that salt, so the raw PIN never has
-- to be compared server-side either).
CREATE TABLE security_lock_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL UNIQUE REFERENCES businesses(id),

  pin_salt TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  argon2_params JSONB NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
