-- Phase: DSPy prompt optimization - a real, human-approved-only channel for
-- an offline DSPy pipeline (services/prompt-optimizer/, a separate Python
-- process, never merged into this codebase and never given live DB
-- credentials) to propose a better ai_agents.system_instruction. Nothing
-- here is ever auto-applied: a row lands 'pending_review' and only takes
-- effect on the live agent when a real operator approves it through the
-- API (see promptOptimizationService.ts).
CREATE TABLE ai_agent_prompt_optimizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  agent_id UUID NOT NULL REFERENCES ai_agents(id),

  source TEXT NOT NULL DEFAULT 'dspy'
    CHECK (source IN ('dspy')),
  status TEXT NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review', 'approved', 'rejected')),

  -- A snapshot of the agent's system_instruction at import time, so the
  -- operator (and this row's own history) can see exactly what changed -
  -- the live agent may have been edited again since, independent of this.
  baseline_instruction TEXT,
  optimized_instruction TEXT NOT NULL,

  metric_name TEXT,
  metric_score DOUBLE PRECISION,
  -- e.g. {"exampleCount": 40, "optimizer": "BootstrapFewShot", "model": "gemini-3.5-flash"}
  dataset_summary JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  rejection_reason TEXT
);

CREATE INDEX idx_ai_agent_prompt_optimizations_agent
  ON ai_agent_prompt_optimizations (agent_id, created_at DESC);

CREATE INDEX idx_ai_agent_prompt_optimizations_business_status
  ON ai_agent_prompt_optimizations (business_id, status);
