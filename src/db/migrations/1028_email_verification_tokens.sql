-- One-time tokens proving somebody can actually read the address they
-- signed up with.
--
-- WHAT IT IS FOR. A fake account costs nothing to create if the email on it
-- is never checked - type anything@anywhere and you have a trial. Requiring
-- a click in a real inbox is the cheapest honest barrier there is: it costs
-- a genuine person five seconds and it costs a bulk signup script an actual
-- mailbox per account. reCAPTCHA (already on the trial signup route) stops
-- the script; this stops the addresses.
--
-- THE TOKEN CARRIES NO IDENTITY. It is 32 random bytes and nothing else -
-- no name, no email, no user id, nothing encoded and nothing derivable.
-- Anyone who intercepts the link learns only that somebody, somewhere,
-- signed up. The row here is what ties it to an account, and it never
-- leaves the database.
--
-- ONLY THE HASH IS STORED, for the same reason as password_reset_tokens
-- (1026): a token is a bearer credential, so a database dump or a leaked
-- backup must not be enough to verify somebody else's address.

CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Supports the resend rate limit, and finding a user's outstanding tokens
-- to retire when one is spent.
CREATE INDEX IF NOT EXISTS idx_email_verification_tokens_user
  ON email_verification_tokens (user_id, created_at DESC);

-- No RLS, same as 1026: these rows are pre-authentication by definition -
-- there is no session and no tenant context to scope them to, and the only
-- code that reads them looks one hash up directly.
