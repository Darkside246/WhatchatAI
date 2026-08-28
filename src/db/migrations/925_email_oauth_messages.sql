-- Synced messages from OAuth-connected email accounts.
-- Provides the unified inbox view across Gmail, Outlook, and app email.

CREATE TABLE email_oauth_messages (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           UUID        NOT NULL REFERENCES email_oauth_accounts (id) ON DELETE CASCADE,
  provider_message_id  TEXT        NOT NULL,
  provider_thread_id   TEXT,
  folder               TEXT        NOT NULL DEFAULT 'INBOX',
  subject              TEXT,
  from_address         TEXT,
  from_name            TEXT,
  to_addresses         TEXT,
  snippet              TEXT,
  body_html            TEXT,
  body_text            TEXT,
  is_read              BOOLEAN     NOT NULL DEFAULT false,
  is_starred           BOOLEAN     NOT NULL DEFAULT false,
  labels               TEXT[],
  received_at          TIMESTAMPTZ,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_email_oauth_msgs_provider_msg
  ON email_oauth_messages (account_id, provider_message_id);

CREATE INDEX idx_email_oauth_msgs_account_received
  ON email_oauth_messages (account_id, received_at DESC NULLS LAST);

CREATE INDEX idx_email_oauth_msgs_account_unread
  ON email_oauth_messages (account_id, is_read)
  WHERE is_read = false;
