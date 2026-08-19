-- Real security event log: Sentinel verdicts, lock/unlock attempts, and
-- similar. raw_metadata is for structural/diagnostic context (rule ids,
-- scores, error codes) only - never message text or PII. Enforced at the
-- application layer (the writers in this codebase never pass message
-- bodies/contact names/phone numbers into raw_metadata).
CREATE TABLE security_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID REFERENCES whatsapp_accounts(id),

  event_type TEXT NOT NULL CHECK (event_type IN (
    'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
    'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  reason TEXT,
  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX security_audit_logs_business_idx ON security_audit_logs (business_id, created_at DESC);
