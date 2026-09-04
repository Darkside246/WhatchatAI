-- Section 41-42 Phase 1 (Autonomous Operations Layer): the user replaced
-- the original vague "autonomous work loop" scope with a ~100-item
-- specification for a full system. This ships the genuinely buildable
-- Phase 1 slice - see AURA_MASTER_CHECKLIST.md's own write-up for what's
-- reused untouched (the existing risk/policy engine, action bus, next-
-- best-action engine, recurring-sweep job pattern) versus what's
-- deliberately deferred (overnight time windows, simulation mode, trust
-- score, task graphs).

-- A separate axis from the existing autonomy_level (migration 961), which
-- governs how an agent replies to an inbound message. This one governs
-- whether the business gets swept for UNPROMPTED work at all, and how much
-- of what the sweep finds it may act on without a human:
--   OFF       - never swept (default - nothing opts in silently)
--   ASSISTED  - swept, but every finding is a suggestion only, logged to
--               the work journal - nothing auto-executes
--   DELEGATED / AUTONOMOUS - the one real LOW-risk action type (creating a
--               follow-up reminder) is auto-executed; identical in Phase 1
--               since no axis yet exists to tell them apart (see write-up)
ALTER TABLE ai_agents ADD COLUMN proactive_mode TEXT NOT NULL DEFAULT 'OFF'
  CHECK (proactive_mode IN ('OFF', 'ASSISTED', 'DELEGATED', 'AUTONOMOUS'));

-- Append-only record of what the autonomous sweep found and did - backs
-- both the Morning Briefing's new "While You Were Away" section and a
-- plain audit trail of every real action the sweep ever took. agent_id is
-- ON DELETE SET NULL, same reasoning as ai_usage_events.agent_id: a
-- deleted agent's history still means something even once the agent
-- itself is gone.
CREATE TABLE agent_work_journal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('FINDING', 'ACTION_TAKEN', 'QUEUED_FOR_APPROVAL', 'SKIPPED')),
  summary TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_agent_work_journal_business_time ON agent_work_journal (business_id, occurred_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON agent_work_journal TO whatchatai_tenant;
ALTER TABLE agent_work_journal ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_work_journal USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
