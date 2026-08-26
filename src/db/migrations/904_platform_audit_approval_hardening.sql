-- The canonical approval table is platform_approvals from migration 901.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_approval_one_pending
  ON platform_approvals (business_id, action_request_id)
  WHERE status = 'PENDING';

-- Audit events are append-only.
CREATE OR REPLACE FUNCTION platform_audit_events_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_audit_events_immutable ON platform_audit_events;
CREATE TRIGGER trg_platform_audit_events_immutable
  BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform_audit_events_immutable();

-- If an older build created the duplicate table, migrate any still-pending
-- decisions into the canonical table, then remove the duplicate.
DO $$
BEGIN
  IF to_regclass('public.platform_action_approvals') IS NOT NULL THEN
    INSERT INTO platform_approvals (id, business_id, action_request_id, status, approver_user_id, decision_reason, created_at, decided_at)
      SELECT id, business_id, action_request_id,
             status,
             decided_by_user_id,
             reason,
             created_at,
             decided_at
      FROM platform_action_approvals
      ON CONFLICT (business_id, action_request_id) DO NOTHING;
    DROP TABLE platform_action_approvals;
  END IF;
END $$;
