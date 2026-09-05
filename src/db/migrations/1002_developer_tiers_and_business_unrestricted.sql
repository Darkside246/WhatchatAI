-- Developer Control Plane: tiered developer roles + a real per-business
-- "unrestricted, no tier/trial gating" flag.
--
-- platform_role (908_platform_roles.sql) is a flat CLIENT/DEVELOPER
-- boolean today. developer_tier adds one more axis, meaningful only when
-- platform_role = 'DEVELOPER': ADMIN can manage other developers'
-- accounts and grant/revoke a business's tier_unrestricted flag; STANDARD
-- keeps every other existing DEVELOPER capability unchanged (clients,
-- plans, governance, billing/payment toggles, kill switches, etc. -
-- nothing about those routes' own requireDeveloper gate changes).
ALTER TABLE users ADD COLUMN developer_tier TEXT
  CHECK (developer_tier IN ('ADMIN', 'STANDARD'));
ALTER TABLE users ADD CONSTRAINT users_developer_tier_requires_developer_role
  CHECK (developer_tier IS NULL OR platform_role = 'DEVELOPER');

-- businesses.tier_unrestricted: a real, explicit, Admin-granted exemption
-- from subscription/trial/entitlement gating - distinct from simply being
-- on a very generous plan. EntitlementService's checkEntitlement/canXxx
-- methods short-circuit `{allowed: true, limit: null}` when this is true,
-- and requireActiveSubscription (authMiddleware.ts) treats it the same
-- way it already treats platformRole === 'DEVELOPER'. Default false -
-- zero behavior change for every existing business.
ALTER TABLE businesses ADD COLUMN tier_unrestricted BOOLEAN NOT NULL DEFAULT false;

-- Seed: the platform's own account becomes the sole Admin developer, and
-- their own business becomes unrestricted - the two changes this whole
-- migration exists to make real. Matched by email since this predates any
-- generated id being known at migration-write time.
UPDATE users SET developer_tier = 'ADMIN'
  WHERE email = 'hasan.alkins@gmail.com' AND platform_role = 'DEVELOPER';

UPDATE businesses SET tier_unrestricted = true
  WHERE id IN (
    SELECT bm.business_id FROM business_memberships bm
    JOIN users u ON u.id = bm.user_id
    WHERE u.email = 'hasan.alkins@gmail.com' AND bm.role = 'OWNER'
  );

-- That business no longer needs a product_trials row at all now that it's
-- unrestricted outright - cancel it rather than leaving it to (falsely)
-- keep counting against getControlPlaneStats' active-trials number.
UPDATE product_trials SET state = 'CANCELLED', updated_at = now()
  WHERE state IN ('ACTIVE', 'EXPIRING')
    AND trial_identity_id IN (SELECT id FROM trial_identities WHERE email = 'hasan.alkins@gmail.com');

-- security_audit_logs.event_type - full restatement (999 was the last to
-- touch it) plus five new values for developer-management and the
-- tier-unrestricted grant/revoke action.
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
  'relationship_suggestion_computed', 'relationship_suggestion_overridden',
  'developer_promoted', 'developer_demoted', 'developer_tier_changed',
  'business_tier_unrestricted_granted', 'business_tier_unrestricted_revoked'
));
