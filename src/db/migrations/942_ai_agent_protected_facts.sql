-- Adds a structured "protected facts" list to ai_agents - specific real
-- facts (names, school, address, etc.) an operator declares must never be
-- disclosed in an AI-generated reply. Same JSON-array-of-strings shape as
-- the existing trigger_keywords/blocked_keywords columns (migration 042),
-- for the same reason: a code-addressable list, not free text buried
-- inside system_instruction, is what makes an automatic check possible
-- (see src/security/sentinel/outboundLeakGuard.ts).
ALTER TABLE ai_agents
  ADD COLUMN protected_facts JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Adds ai_output_leak_blocked and ai_output_leak_check_unavailable to
-- security_audit_logs_event_type_check - see
-- securityAuditLogRepository.ts's SecurityEventType union and
-- outboundLeakGuard.ts. Per 927/940's established convention: this
-- constraint is the single source of truth, rewritten wholesale (not
-- incrementally), copied exactly from the TypeScript union so the two
-- never drift apart.
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
  'contact_privacy_updated',
  'handover_auto_reverted',
  'account_deletion_requested', 'account_deletion_cancelled', 'phone_number_changed',
  'ai_output_leak_blocked', 'ai_output_leak_check_unavailable'
));
