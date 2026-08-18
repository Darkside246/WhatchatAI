-- Phase G1: configure email and the Goose failover from inside the app,
-- instead of editing environment variables on the server.
--
-- SECRET HANDLING. Every secret column here stores a serialized AES-256-GCM
-- envelope produced by EncryptionService (the same mechanism message bodies
-- use), never a plaintext key or SMTP password. The API never returns these
-- values back to the browser - it returns only whether one is set - so a
-- compromised session cannot read out the workspace's mail credentials.
--
-- These settings OVERRIDE the corresponding environment variables when
-- present. That precedence is deliberate and is reported honestly in the UI,
-- so an operator can always tell whether the value in effect came from this
-- table or from the server's environment.

ALTER TABLE business_email_settings
  -- 'resend' talks to the Resend HTTP API; 'smtp' is a normal mail server,
  -- which is what most businesses already have.
  ADD COLUMN provider TEXT NOT NULL DEFAULT 'resend'
    CHECK (provider IN ('resend', 'smtp')),
  ADD COLUMN resend_api_key_encrypted TEXT,
  ADD COLUMN smtp_host TEXT,
  ADD COLUMN smtp_port INTEGER CHECK (smtp_port IS NULL OR (smtp_port > 0 AND smtp_port <= 65535)),
  -- Implicit TLS (port 465) versus STARTTLS (587). Getting this wrong is the
  -- single most common mail misconfiguration, so it is explicit.
  ADD COLUMN smtp_secure BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN smtp_username TEXT,
  ADD COLUMN smtp_password_encrypted TEXT,
  -- Result of the last real test send: proof the settings work, or the real
  -- error. Never assumed from the values being present.
  ADD COLUMN last_test_at TIMESTAMPTZ,
  ADD COLUMN last_test_ok BOOLEAN,
  ADD COLUMN last_test_error TEXT;

-- Goose is configured per workspace rather than per process so it can be set
-- up from the UI. See docs/reference/goose-integration.md for what this URL
-- must actually implement - it is NOT a plain Goose install.
CREATE TABLE business_goose_settings (
  business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  service_url TEXT,
  api_key_encrypted TEXT,
  last_test_at TIMESTAMPTZ,
  last_test_ok BOOLEAN,
  last_test_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed',
  'agent_updated',
  'message_revoke_requested', 'campaign_recalled', 'status_revoke_requested',
  'email_drafted', 'email_approved', 'email_sent', 'email_cancelled', 'email_settings_updated',
  'email_test_sent', 'goose_settings_updated', 'goose_tested'
));
