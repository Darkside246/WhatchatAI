-- Relationship-Confidence Engine (Phase 3) - an advisory-only signal for
-- the genuinely ambiguous case Lists Phase 1 deliberately left as a safe
-- "never guess" null (see listRoutingService.ts's computeUnambiguousActiveList).
-- Deterministic keyword-count scoring only (reuses agentRoutingService.ts's
-- own matchesKeyword/firstMatch against each candidate List's assigned
-- agent's own triggerKeywords) - never an LLM call, never a fabricated
-- confidence float. This engine NEVER writes whatsapp_chats.active_list_id
-- itself - that column stays exclusively human-set, preserving Lists
-- Phase 1's own non-destructive guarantee.

-- Fail-closed, matches customer_memory_enabled's own default-off posture -
-- nothing about this phase changes behavior for a business that hasn't
-- explicitly turned it on.
ALTER TABLE businesses ADD COLUMN relationship_confidence_enabled BOOLEAN NOT NULL DEFAULT false;

-- One row per chat that has ever been ambiguous, refreshed IN PLACE (not
-- appended) each time routing recomputes it - "at all times" visibility
-- means always current, not a growing history log. candidates carries
-- denormalized list/agent names so the developer-facing UI never needs a
-- second join, same reasoning as governance_flags' own server-side join.
CREATE TABLE chat_relationship_signals (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id        UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  chat_id            UUID        NOT NULL REFERENCES whatsapp_chats (id) ON DELETE CASCADE,
  candidates         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  suggested_list_id  UUID        REFERENCES lists (id) ON DELETE SET NULL,
  computed_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, chat_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON chat_relationship_signals TO whatchatai_tenant;
ALTER TABLE chat_relationship_signals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_relationship_signals USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- security_audit_logs.event_type - full restatement (998 was the last
-- migration to touch this constraint), extended with 4 new relationship-
-- confidence event types.
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
  'governance_flag_raised', 'governance_flag_reviewed', 'governance_flag_dismissed',
  'relationship_confidence_enabled', 'relationship_confidence_disabled',
  'relationship_suggestion_computed', 'relationship_suggestion_overridden'
));
