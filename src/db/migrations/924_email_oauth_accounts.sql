-- OAuth-connected external email accounts (Gmail, Outlook).
-- Tokens stored as AES-256-GCM ciphertext via the per-tenant EncryptionService.

CREATE TABLE email_oauth_accounts (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  provider            TEXT        NOT NULL CHECK (provider IN ('gmail', 'outlook')),
  email_address       TEXT        NOT NULL,
  display_name        TEXT,
  -- AES-256-GCM serialized ciphertexts (EncryptionService.serialize output)
  access_token_enc    TEXT        NOT NULL,
  refresh_token_enc   TEXT,
  token_expires_at    TIMESTAMPTZ,
  scopes              TEXT,
  -- sync state
  sync_cursor         TEXT,
  last_synced_at      TIMESTAMPTZ,
  sync_enabled        BOOLEAN     NOT NULL DEFAULT true,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Each business can connect one account per provider (can be relaxed later).
CREATE UNIQUE INDEX idx_email_oauth_accounts_business_provider
  ON email_oauth_accounts (business_id, provider);

CREATE INDEX idx_email_oauth_accounts_business
  ON email_oauth_accounts (business_id);
