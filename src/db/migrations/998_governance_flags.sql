-- AI Governance & Oversight (v1) - a developer-facing dashboard on top of
-- the EXISTING security_audit_logs trail (agentGuard.ts's ai_tool_invoked/
-- ai_tool_denied, sentinel.ts's sentinel_*, the outbound leak guard's
-- ai_output_leak_*), with a handful of concrete threshold rules computed
-- by a scheduled sweep (governanceSweepService.ts). Deliberately NOT
-- ML-based drift detection or compliance-framework mapping - see that
-- file's own header comment for the full explicitly-deferred list.
--
-- flag_type is kept to exactly three values, not a speculative larger
-- taxonomy, because each maps to exactly one already-flowing,
-- already-audited signal:
--   high_tool_denial_rate    - agentGuard.ts's ai_tool_denied, per (business, agent)
--   high_sentinel_block_rate - sentinel.ts's sentinel_heuristic_block +
--                              sentinel_ai_block, per business (sentinel
--                              never records an agentId - see sentinel.ts)
--   high_output_leak_rate    - the outbound leak guard's
--                              ai_output_leak_blocked, per business (same
--                              reason - no agentId recorded)
-- A fourth, per-agent variant of the latter two would require first
-- changing sentinel.ts/the outbound leak guard to also record agentId -
-- out of scope for v1.
CREATE TABLE governance_flags (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id          UUID        REFERENCES businesses (id) ON DELETE CASCADE,
  agent_id             UUID        REFERENCES ai_agents (id) ON DELETE CASCADE,
  flag_type            TEXT        NOT NULL CHECK (flag_type IN ('high_tool_denial_rate', 'high_sentinel_block_rate', 'high_output_leak_rate')),
  -- Matches security_audit_logs.severity's own 3-value enum rather than
  -- inventing a parallel 5-value RECOMMENDATION/WARNING/REVIEW REQUIRED/
  -- ACTION BLOCKED/SECURITY ALERT taxonomy - streamlined, not a claim of
  -- the directive's full ambition.
  severity             TEXT        NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  -- The real computed count and the threshold AT FLAG TIME, so a later
  -- threshold change never retroactively re-contextualizes an old flag.
  metric_value         NUMERIC     NOT NULL,
  threshold_value      NUMERIC     NOT NULL,
  window_start         TIMESTAMPTZ NOT NULL,
  window_end           TIMESTAMPTZ NOT NULL,
  -- Closing is final - no reopen. Matches security_audit_logs' own
  -- insert-only philosophy: if the condition recurs, the sweep's own
  -- de-dup rule (governanceSweepService.ts) creates a fresh row once the
  -- prior one is resolved, preserving the full historical review trail
  -- rather than overwriting it.
  status               TEXT        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewed', 'dismissed')),
  reviewed_by_user_id  UUID        REFERENCES users (id) ON DELETE SET NULL,
  reviewed_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- high_tool_denial_rate is the one per-agent rule - agent_id required;
  -- the other two are business-scoped only, matching what sentinel.ts/the
  -- leak guard actually record (no agentId).
  CHECK (
    (flag_type = 'high_tool_denial_rate' AND agent_id IS NOT NULL) OR
    (flag_type IN ('high_sentinel_block_rate', 'high_output_leak_rate') AND agent_id IS NULL)
  )
);

CREATE INDEX idx_governance_flags_open ON governance_flags (status, created_at DESC) WHERE status = 'open';
-- De-duplication lookup the sweep runs every tick (see governanceSweepService.ts).
CREATE INDEX idx_governance_flags_dedup ON governance_flags (business_id, agent_id, flag_type) WHERE status = 'open';

GRANT SELECT, INSERT, UPDATE, DELETE ON governance_flags TO whatchatai_tenant;
ALTER TABLE governance_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON governance_flags USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
-- Deliberate tenant-agnostic exception: the developer dashboard's own
-- cross-business open-flag listing (governanceFlagRepository.listOpenAcrossPlatform)
-- goes through the bare pool (RLS-exempt owner role), mirroring
-- SecurityAuditLogRepository.listPlatformEvents's own precedent - every
-- tenant-scoped read/write path (listForBusiness, markReviewed,
-- markDismissed) still goes through queryAsTenant(businessId) and is
-- fully protected by the policy above.

-- security_audit_logs.event_type - full restatement (997 was the last
-- migration to touch this constraint), extended with 3 new governance
-- lifecycle event types.
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
  'platform_setting_updated',
  'subscription_plan_manually_changed',
  'bi_settings_enabled', 'bi_settings_disabled',
  'bi_insight_approved', 'bi_insight_rejected', 'bi_insight_held',
  'bi_security_alert_detected',
  'list_created', 'list_deleted',
  'list_agent_assigned', 'list_agent_unassigned',
  'list_membership_changed', 'list_active_list_set',
  'list_routed', 'list_scoped_memory_erased',
  'governance_flag_raised', 'governance_flag_reviewed', 'governance_flag_dismissed'
));
