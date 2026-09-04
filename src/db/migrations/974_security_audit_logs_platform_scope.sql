-- Section 116 (audit logging): billingRoutes.ts's developer-only plan/
-- entitlement-config routes (PATCH /developer/plans/:planId, PUT
-- /developer/plans/:planId/entitlements/:entitlementKey) and
-- productAccountRoutes.ts's POST /developer/accounts/:businessId/assign-vertical
-- mutate real platform state with zero audit trail today - a real gap,
-- distinct from payment_audit_events (which already covers every
-- payment_attempt-scoped event: checkout, verification, proof review).
--
-- vertical_assigned is business-scoped like every existing event type.
-- plan_updated/plan_entitlement_updated are NOT: a plan applies across
-- every business subscribed to it, so there is no single business_id to
-- attach the event to. business_id becomes nullable to allow these two
-- platform-wide events - same precedent as platform_skills.business_id
-- (migration 951: "a global, non-tenant skill has business_id IS NULL"),
-- and migration 958's tenant_isolation RLS policy already fails closed on
-- a NULL business_id (NULL = anything is never true), so a NULL-scoped row
-- here is automatically invisible to any business-scoped queryAsTenant
-- read without any further RLS change.
ALTER TABLE security_audit_logs ALTER COLUMN business_id DROP NOT NULL;

-- Per 927/940/962/971's established convention: this constraint is the
-- single source of truth, rewritten wholesale (not incrementally) from
-- SecurityEventType's own union, copied exactly.
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
  'contact_privacy_updated', 'crm_contact_memory_erased',
  'handover_auto_reverted',
  'account_deletion_requested', 'account_deletion_cancelled', 'phone_number_changed',
  'ai_output_leak_blocked', 'ai_output_leak_check_unavailable',
  'message_risk_flagged',
  'plan_updated', 'plan_entitlement_updated', 'vertical_assigned'
));
