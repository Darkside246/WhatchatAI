-- One live approval record per action. Existing duplicates are preserved as
-- historical rows if any exist; the unique index applies only to pending rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_action_pending_approval
  ON platform_action_approvals (business_id, action_request_id)
  WHERE status = 'PENDING';

-- Audit events are append-only. Application code cannot update/delete them
-- through the normal database role after this migration.
CREATE OR REPLACE FUNCTION platform_audit_events_immutable() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_events is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_audit_events_immutable ON platform_audit_events;
CREATE TRIGGER trg_platform_audit_events_immutable
  BEFORE UPDATE OR DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform_audit_events_immutable();
