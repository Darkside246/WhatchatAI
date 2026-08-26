CREATE TABLE IF NOT EXISTS platform_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'DRAFT',
  purpose TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
  tool_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  policy_profile_id TEXT NOT NULL,
  escalation_policy_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS platform_skills (
  id TEXT NOT NULL,
  business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  manifest JSONB NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (business_id, id, version)
);

CREATE TABLE IF NOT EXISTS platform_agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL,
  capability_id TEXT NOT NULL,
  input JSONB NOT NULL,
  context_entity_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  correlation_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'QUEUED',
  execution_id TEXT,
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, agent_id) REFERENCES platform_agents (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_action_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  requested_by_kind TEXT NOT NULL,
  requested_by_id TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  approval_required BOOLEAN NOT NULL,
  approval_status TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, idempotency_key),
  UNIQUE (business_id, id)
);

CREATE TABLE IF NOT EXISTS platform_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  action_request_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  approver_user_id UUID,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at TIMESTAMPTZ,
  UNIQUE (business_id, action_request_id),
  FOREIGN KEY (business_id, action_request_id) REFERENCES platform_action_requests (business_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS platform_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  sequence BIGINT NOT NULL,
  event_type TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  correlation_id UUID NOT NULL,
  action_request_id UUID,
  payload JSONB NOT NULL,
  payload_hash TEXT NOT NULL,
  previous_hash TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (business_id, sequence),
  UNIQUE (business_id, id),
  FOREIGN KEY (business_id, action_request_id) REFERENCES platform_action_requests (business_id, id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_platform_agents_business_status ON platform_agents (business_id, status);
CREATE INDEX IF NOT EXISTS idx_platform_agent_tasks_business_status ON platform_agent_tasks (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_actions_business_status ON platform_action_requests (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_approvals_business_status ON platform_approvals (business_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_business_sequence ON platform_audit_events (business_id, sequence);

CREATE OR REPLACE FUNCTION platform_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_platform_agents_updated_at ON platform_agents;
CREATE TRIGGER trg_platform_agents_updated_at BEFORE UPDATE ON platform_agents FOR EACH ROW EXECUTE FUNCTION platform_touch_updated_at();
DROP TRIGGER IF EXISTS trg_platform_skills_updated_at ON platform_skills;
CREATE TRIGGER trg_platform_skills_updated_at BEFORE UPDATE ON platform_skills FOR EACH ROW EXECUTE FUNCTION platform_touch_updated_at();
DROP TRIGGER IF EXISTS trg_platform_action_requests_updated_at ON platform_action_requests;
CREATE TRIGGER trg_platform_action_requests_updated_at BEFORE UPDATE ON platform_action_requests FOR EACH ROW EXECUTE FUNCTION platform_touch_updated_at();

-- Exactly one event sequence can be claimed per business. Application code must
-- append under a transaction and retry on a unique-sequence conflict.
