-- One Google account connection per business, used to book real Google
-- Meet calls (via a real Calendar event) directly from the AI reply tool -
-- see scheduleMeetingTool.ts. Mirrors email_oauth_accounts's exact shape
-- (924_email_oauth_accounts.sql) - a deliberately separate connection,
-- not folded into that table, since a business may want one grant
-- without the other and Google issues independently-scoped tokens per
-- consent flow regardless of the client id used.
CREATE TABLE google_meeting_connections (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  google_email          TEXT        NOT NULL,
  display_name          TEXT,
  access_token_enc      TEXT        NOT NULL,
  refresh_token_enc     TEXT,
  token_expires_at      TIMESTAMPTZ,
  scopes                TEXT,
  connected_by_user_id  UUID        REFERENCES users (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_google_meeting_connections_business ON google_meeting_connections (business_id);
