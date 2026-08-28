-- security_audit_logs_event_type_check has drifted from the application's
-- own SecurityEventType union (src/repositories/securityAuditLogRepository.ts)
-- for a while: this constraint is rewritten wholesale on every addition
-- (13 migrations do a DROP CONSTRAINT + ADD CONSTRAINT with the full
-- hardcoded list each time), and at some point along that chain - migration
-- 920 is the clearest culprit, since its list matches an era before 067/069/
-- 058 added the business_document_*/writing_twin_*/ai_prompt_optimization_*
-- values - a rewrite was authored from a stale copy and silently dropped
-- values that earlier migrations had already added. lock_pin_changed,
-- contact_privacy_updated, and handover_auto_reverted appear to have never
-- been added at all, despite being real, already-shipped SecurityEventType
-- members with call sites in securityLockService.ts, server/index.ts, and
-- workspaceService.ts respectively.
--
-- Net effect in production: every one of those code paths threw a check
-- constraint violation on its audit-log write. Found via a full test suite
-- run (66 failing tests across 15 files, nearly all this one root cause) -
-- this had not actually been run clean before.
--
-- This migration is the new single source of truth: the full list below is
-- SecurityEventType's own union, copied exactly, not reconstructed from
-- migration history. Future additions should keep both in sync directly -
-- the type is what a caller can express, this constraint is what the
-- database will actually accept, and they must never diverge again.
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
  'handover_auto_reverted'
));
