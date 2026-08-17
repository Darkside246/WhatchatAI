-- Phase B14: extend the security_audit_logs event-type vocabulary to cover
-- the real mutating actions added across campaigns/funnels/teams/members
-- this phase, and add real per-plan entitlement limits for campaigns and
-- funnels (previously only a hardcoded safety cap in campaignService.ts).
ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed'
));

INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
SELECT id, 'max_active_campaigns', 1, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'max_active_funnels', 1, true FROM plans WHERE plan_key = 'starter'

UNION ALL SELECT id, 'max_active_campaigns', 5, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'max_active_funnels', 5, true FROM plans WHERE plan_key = 'growth'

UNION ALL SELECT id, 'max_active_campaigns', 20, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'max_active_funnels', 20, true FROM plans WHERE plan_key = 'business'

UNION ALL SELECT id, 'max_active_campaigns', NULL, true FROM plans WHERE plan_key = 'enterprise'
UNION ALL SELECT id, 'max_active_funnels', NULL, true FROM plans WHERE plan_key = 'enterprise';
