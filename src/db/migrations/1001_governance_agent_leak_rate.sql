-- AI Governance & Oversight follow-up: a per-agent variant of the
-- business-scoped high_output_leak_rate rule. A real discovery made this
-- cheap: aiOrchestrator.ts's guardGeneratedText (the Outbound Leak
-- Guard's own audit-write call) ALREADY records rawMetadata.agentId on
-- both ai_output_leak_blocked and ai_output_leak_check_unavailable - no
-- write-side change needed at all. governanceSweepService.ts's existing
-- countGroupedByAgentSince() (built for high_tool_denial_rate) already
-- works against this event type unchanged.
--
-- Additive only - the existing business-scoped high_output_leak_rate rule
-- (agent_id IS NULL) is completely untouched; this is a new, separate
-- flag_type value requiring agent_id IS NOT NULL, mirroring
-- high_tool_denial_rate's own shape exactly.
ALTER TABLE governance_flags DROP CONSTRAINT governance_flags_flag_type_check;
ALTER TABLE governance_flags ADD CONSTRAINT governance_flags_flag_type_check
  CHECK (flag_type IN ('high_tool_denial_rate', 'high_sentinel_block_rate', 'high_output_leak_rate', 'high_agent_output_leak_rate'));

ALTER TABLE governance_flags DROP CONSTRAINT IF EXISTS governance_flags_check;
ALTER TABLE governance_flags ADD CONSTRAINT governance_flags_check CHECK (
  (flag_type IN ('high_tool_denial_rate', 'high_agent_output_leak_rate') AND agent_id IS NOT NULL) OR
  (flag_type IN ('high_sentinel_block_rate', 'high_output_leak_rate') AND agent_id IS NULL)
);
