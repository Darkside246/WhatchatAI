-- Fencing generation for OpenClaw cells: increments every time a cell's
-- underlying container is genuinely replaced (initial provision, and
-- every `fleet upgrade`) - start/stop preserve the same container and do
-- NOT bump this. A tool-gateway request carries the generation the
-- calling cell believes it's running as; a mismatch means the request
-- originated from a stale/replaced cell instance and is fenced out.
ALTER TABLE openclaw_fleet_cells ADD COLUMN generation INTEGER NOT NULL DEFAULT 1;

-- The durable record behind the OpenClaw Tool Gateway: one row per tool
-- invocation *attempt*, approved or denied - this is both the real
-- idempotency store (a repeated idempotency_key returns the prior
-- outcome rather than re-executing) and the audit trail the standing
-- instruction requires ("record every security decision in PostgreSQL").
-- Deliberately NOT scoped to any one entity type - entity_type/entity_id
-- are free-form, validated by the calling code against the entity
-- ownership registry, not by a FK here (a lead and a future appointment
-- share this same execution log).
CREATE TABLE openclaw_tool_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  fleet_cell_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  requested_fields JSONB NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('APPROVED', 'DENIED')),
  denial_reason TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Idempotency is scoped per business+tool+key, never globally - two
  -- different tenants (or two different tools) reusing the same
  -- idempotency key string are two unrelated operations.
  UNIQUE (business_id, tool_name, idempotency_key)
);

CREATE INDEX idx_openclaw_tool_executions_rate_limit ON openclaw_tool_executions (business_id, tool_name, created_at);
