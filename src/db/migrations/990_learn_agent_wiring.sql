-- AURA Learn Agent (Personal Communication Intelligence) - completes and
-- rebrands Phase W3 "Writing Twin" rather than building parallel storage.
-- Everything Writing Twin already built (encrypted style examples,
-- versioned profiles, retention sweep, deletion/reset, audit events) is
-- reused unchanged - this migration only adds what was missing: RLS (a
-- real pre-existing gap on every writing_twin_* table), the independent
-- "share with agents" toggle, and per-agent access control, per the
-- spec's explicit "most restrictive permission wins" and "separate,
-- encrypted, only accessible by the AI that feeds it" requirements.

-- 1. RLS backfill - closes a real gap: every other tenant-scoped table
-- added since migration 944/960 has this, writing_twin_* never did.
-- Every repository call already threads business_id through explicitly,
-- so this is a database-enforced backstop, not a behavior change.
GRANT SELECT, INSERT, UPDATE, DELETE ON writing_twin_settings TO whatchatai_tenant;
ALTER TABLE writing_twin_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON writing_twin_settings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON writing_twin_profiles TO whatchatai_tenant;
ALTER TABLE writing_twin_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON writing_twin_profiles USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON writing_twin_style_examples TO whatchatai_tenant;
ALTER TABLE writing_twin_style_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON writing_twin_style_examples USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON writing_twin_raw_events TO whatchatai_tenant;
ALTER TABLE writing_twin_raw_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON writing_twin_raw_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- writing_twin_profile_derivations has no business_id column of its own
-- (it's a pure join table, FK-scoped through writing_twin_profiles) - no
-- RLS policy is meaningful here, matching every other pure join table in
-- this schema.

-- 2. Independent Share toggle - deliberately separate from
-- learning_enabled (spec's 4-state matrix: a business can build a
-- profile with sharing off, but sharing can never itself turn on
-- learning). Defaults false, same fail-closed-by-default posture as
-- learning_enabled's own default.
ALTER TABLE writing_twin_settings ADD COLUMN share_with_agents_enabled BOOLEAN NOT NULL DEFAULT false;

-- 3. Per-agent access control. Absence of a row for a given agent means
-- "not yet decided" and is treated as DENIED everywhere this is read
-- (application-level fail-closed default - a newly created agent never
-- silently inherits access to a prior agent's allow-list).
CREATE TABLE writing_twin_agent_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  user_id UUID NOT NULL,
  agent_id UUID NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  allowed BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (business_id, user_id) REFERENCES business_memberships (business_id, user_id) ON DELETE CASCADE,
  UNIQUE (business_id, user_id, agent_id)
);

CREATE INDEX idx_writing_twin_agent_access_lookup ON writing_twin_agent_access (business_id, user_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON writing_twin_agent_access TO whatchatai_tenant;
ALTER TABLE writing_twin_agent_access ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON writing_twin_agent_access USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- 4. New audit events for the wiring this migration/phase adds. The full
-- enum must be restated (Postgres CHECK constraints have no ALTER-ADD-
-- VALUE form), same convention every prior audit-enum migration follows.
ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked', 'lock_pin_changed',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled', 'campaign_deleted',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled', 'funnel_deleted',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed',
  'agent_updated',
  'message_revoke_requested', 'campaign_recalled', 'status_revoke_requested',
  'email_drafted', 'email_approved', 'email_sent', 'email_cancelled', 'email_settings_updated',
  'email_test_sent', 'goose_settings_updated', 'goose_tested',
  'ai_tool_invoked', 'ai_tool_denied',
  'ai_prompt_optimization_imported', 'ai_prompt_optimization_approved', 'ai_prompt_optimization_rejected',
  'business_document_uploaded', 'business_document_upload_blocked', 'business_document_deleted',
  'business_document_parsed', 'business_document_parse_failed',
  'writing_twin_learning_enabled', 'writing_twin_learning_disabled',
  'writing_twin_backfill_requested', 'writing_twin_deleted', 'writing_twin_profile_reset',
  'writing_twin_example_removed',
  'writing_twin_share_enabled', 'writing_twin_share_disabled',
  'writing_twin_agent_access_changed', 'writing_twin_profile_computed', 'writing_twin_context_served',
  'contact_privacy_updated', 'crm_contact_memory_erased',
  'handover_auto_reverted',
  'account_deletion_requested', 'account_deletion_cancelled', 'phone_number_changed',
  'ai_output_leak_blocked', 'ai_output_leak_check_unavailable',
  'message_risk_flagged',
  'plan_updated', 'plan_entitlement_updated', 'vertical_assigned',
  'platform_setting_updated'
));
