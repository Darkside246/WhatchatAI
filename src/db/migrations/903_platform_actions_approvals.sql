-- Durable platform execution state. Business identity is always carried
-- alongside the row so cross-tenant access can be constrained at SQL level.

CREATE TABLE IF NOT EXISTS platform_action_requests (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  requested_by_kind TEXT NOT NULL CHECK (requested_by_kind IN ('AGENT','USER','SYSTEM')),
  requested_by_id TEXT NOT NULL,
  risk_level TEXT NOT NULL CHECK (risk_level IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  approval_required BOOLEAN NOT NULL DEFAULT FALSE,
  approval_status TEXT NOT NULL CHECK (approval_status IN ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')),
  status TEXT NOT NULL CHECK (status IN ('PENDING_POLICY','PENDING_APPROVAL','READY','EXECUTING','SUCCEEDED','FAILED','CANCELLED')),
  idempotency_key TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_platform_action_business_status
  ON platform_action_requests (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_action_approvals (
  id UUID PRIMARY KEY,
  action_request_id UUID NOT NULL,
  business_id UUID NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING','APPROVED','REJECTED','EXPIRED','CANCELLED')),
  requested_for_permission TEXT,
  requested_by_agent_id TEXT,
  decided_by_user_id UUID,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  CONSTRAINT fk_platform_approval_action_business
    FOREIGN KEY (action_request_id, business_id)
    REFERENCES platform_action_requests (id, business_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_platform_action_one_pending_approval
  ON platform_action_approvals (business_id, action_request_id)
  WHERE status = 'PENDING';

CREATE INDEX IF NOT EXISTS idx_platform_approval_business_status
  ON platform_action_approvals (business_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS platform_audit_events (
  id UUID PRIMARY KEY,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('USER','AGENT','SYSTEM','VENDOR','EXTERNAL')),
  actor_id TEXT NOT NULL,
  correlation_id TEXT NOT NULL,
  action_request_id UUID,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash CHAR(64) NOT NULL,
  previous_hash CHAR(64),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_platform_audit_business_time
  ON platform_audit_events (business_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_action
  ON platform_audit_events (business_id, action_request_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION platform_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_action_updated_at ON platform_action_requests;
CREATE TRIGGER trg_platform_action_updated_at
  BEFORE UPDATE ON platform_action_requests
  FOR EACH ROW EXECUTE FUNCTION platform_touch_updated_at();

CREATE OR REPLACE FUNCTION platform_prevent_audit_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_events are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_audit_immutable_update ON platform_audit_events;
CREATE TRIGGER trg_platform_audit_immutable_update
  BEFORE UPDATE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform_prevent_audit_mutation();

DROP TRIGGER IF EXISTS trg_platform_audit_immutable_delete ON platform_audit_events;
CREATE TRIGGER trg_platform_audit_immutable_delete
  BEFORE DELETE ON platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION platform_prevent_audit_mutation();
