-- Phase F1: make AI agents fully editable and genuinely configurable.
--
-- The original table already held persona/tone/language/system_instruction/
-- greeting/business_context/response_style/handover_rules. What it could not
-- express was WHAT KIND of agent this is, WHEN it should pick up a
-- conversation, WHEN it must never answer, how fast it replies, and where it
-- sits relative to other agents. Those are added here.
--
-- Deliberately NOT added: any column implying a capability with no executor
-- behind it. Agent-to-agent delegation is represented only as a real
-- parent/child link plus a real escalation target; nothing here claims an
-- agent can perform an action (send email, place an order) that the backend
-- cannot actually carry out today.

ALTER TABLE ai_agents
  -- The trade/function this agent covers. Drives a real, category-specific
  -- guardrail block in the system prompt (see aiReplyService): a plumbing
  -- agent handles bookings, quotes, and job status - it must never give
  -- plumbing ADVICE. Same for every regulated/technical trade.
  ADD COLUMN category TEXT NOT NULL DEFAULT 'general' CHECK (category IN (
    'general', 'sales', 'support', 'billing', 'bookings', 'logistics',
    'plumbing', 'electrical', 'mechanical', 'hvac', 'construction',
    'cleaning', 'landscaping', 'it_services', 'beauty', 'hospitality'
  )),
  -- Free-text refinement inside the category, e.g. "emergency callouts only".
  ADD COLUMN specialization TEXT,

  -- Real routing inputs. trigger_keywords decide which agent picks up a
  -- conversation when a business runs more than one; blocked_keywords are a
  -- hard stop - a match never gets an AI reply and escalates to a human.
  ADD COLUMN trigger_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN blocked_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- A real delay applied before an AI reply is dispatched, so replies do not
  -- land unnaturally fast. 0 means send as soon as it is generated.
  ADD COLUMN response_delay_seconds INTEGER NOT NULL DEFAULT 0
    CHECK (response_delay_seconds >= 0 AND response_delay_seconds <= 300),

  -- Where this agent sits in the business's own structure. parent_agent_id is
  -- a real self-reference; escalate_to_agent_id is who this agent hands a
  -- conversation to when it cannot answer. Both are nullable - a flat setup
  -- with one agent stays perfectly valid.
  ADD COLUMN parent_agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  ADD COLUMN escalate_to_agent_id UUID REFERENCES ai_agents(id) ON DELETE SET NULL,

  -- Tie-break when several agents' trigger keywords match. Higher wins.
  ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE INDEX ai_agents_parent_idx ON ai_agents (parent_agent_id) WHERE parent_agent_id IS NOT NULL;
CREATE INDEX ai_agents_category_idx ON ai_agents (business_id, category) WHERE deleted_at IS NULL;

-- The new mutating action this phase introduces needs a real audit event type.
ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed',
  'agent_updated'
));
