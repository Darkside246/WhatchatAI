-- Phase B4: a real, unified notification system. Every notification is a
-- concrete row targeted at exactly one user (never a shared/broadcast row)
-- so read/dismiss state is never accidentally shared across teammates -
-- a business-wide event (e.g. a human handoff) fans out into one row per
-- active member instead.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'HUMAN_HANDOFF', 'NEW_MESSAGE', 'NEW_LEAD', 'MENTION', 'ASSIGNMENT',
    'AI_FAILURE', 'AUTOMATION_FAILURE', 'SYNC_FAILURE', 'PAYMENT_ISSUE',
    'CALL', 'STATUS', 'SLA_BREACH', 'CAMPAIGN_FAILURE', 'SYSTEM'
  )),
  severity TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  body TEXT,
  target_type TEXT,
  target_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);

CREATE INDEX idx_notifications_user_unread ON notifications (user_id, created_at DESC) WHERE dismissed_at IS NULL;
CREATE INDEX idx_notifications_business ON notifications (business_id);
