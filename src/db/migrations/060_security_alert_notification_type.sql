-- Phase 18 (never built until now): scheduled security scans. Real
-- denial events (lock_unlock_failure, ai_tool_denied) were already
-- written to security_audit_logs on every occurrence, but never actually
-- surfaced to the business unless someone happened to read the raw audit
-- log - this notification type is what the scheduled scan
-- (securityScanService.ts) uses to make a concerning pattern visible.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'HUMAN_HANDOFF', 'NEW_MESSAGE', 'NEW_LEAD', 'MENTION', 'ASSIGNMENT',
  'AI_FAILURE', 'AUTOMATION_FAILURE', 'SYNC_FAILURE', 'PAYMENT_ISSUE',
  'CALL', 'STATUS', 'SLA_BREACH', 'CAMPAIGN_FAILURE', 'SYSTEM',
  'SECURITY_ALERT'
));
