-- Adds the two email-verification audit event types.
--
-- Same paired-guard pattern as 1023, 1025 and 1027: the TypeScript union
-- and this CHECK constraint both have to know an event type, and only the
-- union is visible while writing the code. Worth noting that the send here
-- is recorded inside a try/catch, so a missing constraint entry would have
-- failed silently - every welcome email still sent, and no record that any
-- of them were.

ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled',
  'lock_revoked', 'lock_pin_changed', 'campaign_created', 'campaign_approved',
  'campaign_sent', 'campaign_cancelled', 'campaign_deleted', 'funnel_created',
  'funnel_activated', 'funnel_deactivated', 'funnel_enrolled', 'funnel_deleted',
  'team_created', 'chat_assigned', 'member_created', 'member_role_changed',
  'agent_updated', 'agent_deleted', 'message_revoke_requested', 'campaign_recalled',
  'status_revoke_requested', 'email_drafted', 'email_approved', 'email_sent',
  'email_cancelled', 'email_settings_updated', 'email_test_sent', 'goose_settings_updated',
  'goose_tested', 'ai_tool_invoked', 'ai_tool_denied', 'ai_prompt_optimization_imported',
  'ai_prompt_optimization_approved', 'ai_prompt_optimization_rejected', 'business_document_uploaded', 'business_document_upload_blocked',
  'business_document_deleted', 'business_document_parsed', 'business_document_parse_failed', 'writing_twin_learning_enabled',
  'writing_twin_learning_disabled', 'writing_twin_backfill_requested', 'writing_twin_deleted', 'writing_twin_profile_reset',
  'writing_twin_example_removed', 'writing_twin_share_enabled', 'writing_twin_share_disabled', 'writing_twin_agent_access_changed',
  'writing_twin_profile_computed', 'writing_twin_context_served', 'contact_privacy_updated', 'crm_contact_memory_erased',
  'handover_auto_reverted', 'account_deletion_requested', 'account_deletion_cancelled', 'phone_number_changed',
  'ai_output_leak_blocked', 'ai_output_leak_check_unavailable', 'message_risk_flagged', 'plan_updated',
  'plan_entitlement_updated', 'vertical_assigned', 'platform_setting_updated', 'subscription_plan_manually_changed',
  'bi_settings_enabled', 'bi_settings_disabled', 'bi_insight_approved', 'bi_insight_rejected',
  'bi_insight_held', 'bi_security_alert_detected', 'list_created', 'list_deleted',
  'list_agent_assigned', 'list_agent_unassigned', 'list_membership_changed', 'list_active_list_set',
  'list_routed', 'list_scoped_memory_erased', 'governance_flag_raised', 'governance_flag_reviewed',
  'governance_flag_dismissed', 'relationship_confidence_enabled', 'relationship_confidence_disabled', 'relationship_suggestion_computed',
  'relationship_suggestion_overridden', 'developer_promoted', 'developer_demoted', 'developer_tier_changed',
  'business_tier_unrestricted_granted', 'business_tier_unrestricted_revoked', 'auth_rate_limited', 'signup_recaptcha_failed',
  'oversight_finding_raised', 'oversight_finding_status_changed', 'oversight_monitoring_degraded', 'ai_output_team_address_removed',
  'subscription_trial_extended', 'password_changed', 'business_purged_by_developer', 'password_reset_requested',
  'password_reset_completed', 'email_verification_sent', 'email_verified'
));
