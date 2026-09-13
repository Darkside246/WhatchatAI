-- A driver signing in to see their own run.
--
-- A driver is not a user of this business's workspace and must never become
-- one. They are not staff with a dashboard; they are one person who needs to
-- see the four or five orders in their hands and nothing else about the
-- business, its customers, its takings or its other drivers. So this is a
-- separate principal with its own sessions, not a role bolted onto users -
-- a role would inherit every route the workspace already exposes and the
-- only thing standing between a driver and the whole tenant would be a
-- permission string somebody has to remember to check.
--
-- Signing in is a link sent over WhatsApp, because that is the one channel
-- this product already has to every driver and the one thing a driver
-- reliably has on them. No password to set, forget, write on the van, or
-- reuse from somewhere else.

CREATE TABLE IF NOT EXISTS food_driver_sign_in_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL,

  /* SHA-256 of a 32-byte random token, never the token. Not Argon2: that is
     for low-entropy secrets a person chooses, and this one is 256 bits of
     randomness nobody types from memory. A fast hash here is correct and a
     slow one would only make redemption slow. */
  token_hash TEXT NOT NULL UNIQUE,

  /* Short, because a sign-in link sitting in a WhatsApp thread is a key to
     somebody's deliveries. Long enough that a driver can read it on the
     road and act on it when they have stopped. */
  expires_at TIMESTAMPTZ NOT NULL,
  /* Single use. Set the moment it becomes a session. */
  redeemed_at TIMESTAMPTZ,

  /* Who sent it. A link that grants access to a customer's address is an
     act somebody performed, not an event that happened. */
  issued_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (business_id, driver_id) REFERENCES food_drivers (business_id, id) ON DELETE CASCADE
);

/* Only one live invitation per driver: issuing a new link must invalidate
   the last rather than leaving a trail of working keys behind it. The
   repository deletes the old row before inserting; this makes that a rule
   the database keeps rather than a habit the code has. */
CREATE UNIQUE INDEX IF NOT EXISTS food_driver_sign_in_live_idx
  ON food_driver_sign_in_tokens (business_id, driver_id)
  WHERE redeemed_at IS NULL;

CREATE INDEX IF NOT EXISTS food_driver_sign_in_expiry_idx
  ON food_driver_sign_in_tokens (expires_at)
  WHERE redeemed_at IS NULL;

CREATE TABLE IF NOT EXISTS food_driver_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL,

  token_hash TEXT NOT NULL UNIQUE,

  /* A shift, not a fortnight. A driver's phone is the least controlled
     device that will ever hold a session for this business - left in a van,
     handed to somebody else, sold - so the session is deliberately short
     and re-issued by the shop rather than renewed indefinitely. */
  expires_at TIMESTAMPTZ NOT NULL,
  /* The shop taking a driver off the road, or the driver signing out. */
  revoked_at TIMESTAMPTZ,

  /* So the shop can see whether a driver's phone is actually still on this. */
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (business_id, driver_id) REFERENCES food_drivers (business_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS food_driver_sessions_driver_idx
  ON food_driver_sessions (business_id, driver_id, expires_at DESC);

/* Deactivating a driver has to end their access, not just hide them from
   the picker - otherwise "this person no longer works here" leaves a live
   session on their phone with every customer address on it. Enforced in the
   repository, which revokes on deactivation; the index is what makes that
   sweep cheap. */
CREATE INDEX IF NOT EXISTS food_driver_sessions_live_idx
  ON food_driver_sessions (business_id, driver_id)
  WHERE revoked_at IS NULL;

/* Same tenant isolation as every other table this app owns. Note this is
   enforcement against the tenant role, which is what the workspace connects
   as; the driver principal is narrower still and never selects from these
   tables except through its own session lookup. */
GRANT SELECT, INSERT, UPDATE, DELETE ON food_driver_sign_in_tokens, food_driver_sessions TO whatchatai_tenant;

ALTER TABLE food_driver_sign_in_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE food_driver_sessions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON food_driver_sign_in_tokens;
DROP POLICY IF EXISTS tenant_isolation ON food_driver_sessions;

CREATE POLICY tenant_isolation ON food_driver_sign_in_tokens
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON food_driver_sessions
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
