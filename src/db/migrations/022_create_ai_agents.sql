CREATE TABLE ai_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),

  name TEXT NOT NULL,
  description TEXT,
  persona TEXT,
  tone TEXT,
  language TEXT,
  system_instruction TEXT,
  greeting TEXT,
  business_context TEXT,

  allowed_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  forbidden_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  knowledge_sources JSONB NOT NULL DEFAULT '[]'::jsonb,
  response_style TEXT,
  handover_rules JSONB NOT NULL DEFAULT '{}'::jsonb,
  human_takeover_policy TEXT,

  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'ARCHIVED')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Agent-to-conversation routing (Phase 8/Agent Routing) attaches here later;
-- this migration only persists the agent's own configuration.
CREATE INDEX ai_agents_business_idx ON ai_agents (business_id) WHERE deleted_at IS NULL;
