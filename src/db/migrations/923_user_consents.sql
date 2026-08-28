-- Consent records: every submission from the public landing page,
-- with full GDPR audit trail (IP, user-agent, document versions, method).

CREATE TABLE user_consents (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name           TEXT        NOT NULL,
  email               TEXT        NOT NULL,
  phone               TEXT        NOT NULL,
  terms_version       TEXT        NOT NULL,
  privacy_version     TEXT        NOT NULL,
  ip_address          INET,
  user_agent          TEXT,
  marketing_opt_in    BOOLEAN     NOT NULL DEFAULT false,
  confirmation_method TEXT        CHECK (confirmation_method IN ('email', 'qr')),
  confirmed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_user_consents_email       ON user_consents (email);
CREATE INDEX idx_user_consents_created_at  ON user_consents (created_at DESC);
CREATE INDEX idx_user_consents_confirmed   ON user_consents (confirmed_at) WHERE confirmed_at IS NOT NULL;

-- One-time tokens used to confirm consent (email link or QR scan).
CREATE TABLE consent_confirmations (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  consent_id  UUID        NOT NULL REFERENCES user_consents (id) ON DELETE CASCADE,
  token       TEXT        NOT NULL UNIQUE,
  method      TEXT        NOT NULL CHECK (method IN ('email', 'qr')),
  used_at     TIMESTAMPTZ,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_consent_confirmations_token      ON consent_confirmations (token);
CREATE INDEX idx_consent_confirmations_consent_id ON consent_confirmations (consent_id);
