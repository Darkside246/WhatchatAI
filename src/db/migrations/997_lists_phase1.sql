-- AURA Lists (Phase 1 - Routing + Memory-Isolation Boundary). Additive only:
-- existing agent routing (agentRoutingService.ts), memory (customer_memory),
-- and tool gating (agentGuard.ts) are all untouched by this migration -
-- Lists is an optional, opt-in layer that only takes effect once a business
-- actually creates a List and assigns an agent to it.
--
-- The hard-must this phase exists to satisfy: a contact who belongs to two
-- different Lists (e.g. "Work" and "Friends") must have fully isolated
-- memory between them - what one List's agent learns about that person must
-- never be visible to the other List's agent for the same person. That is
-- what list_scoped_memory (below) is for; it is a sibling to customer_memory,
-- never a replacement for it.

CREATE TABLE lists (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  description  TEXT,
  color        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ,
  UNIQUE (business_id, name)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON lists TO whatchatai_tenant;
ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lists USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- Many-to-many: a chat/contact/group can belong to multiple Lists at once
-- (the directive's own explicit example - a contact in both "Work" and
-- "Friends"). Exactly one of chat_id/contact_id/group_id is set, matching
-- member_type - enforced by the CHECK below, not just application code.
-- contact_id references whatsapp_contacts(id), the same FK target
-- whatsapp_chats.contact_id itself already uses (migration 006) - no
-- crm_contacts join is needed to resolve chat -> contact membership.
CREATE TABLE list_members (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  list_id      UUID        NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  member_type  TEXT        NOT NULL CHECK (member_type IN ('chat', 'contact', 'group')),
  chat_id      UUID        REFERENCES whatsapp_chats (id) ON DELETE CASCADE,
  contact_id   UUID        REFERENCES whatsapp_contacts (id) ON DELETE CASCADE,
  group_id     UUID        REFERENCES whatsapp_groups (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (member_type = 'chat'    AND chat_id    IS NOT NULL AND contact_id IS NULL AND group_id IS NULL) OR
    (member_type = 'contact' AND contact_id IS NOT NULL AND chat_id    IS NULL AND group_id IS NULL) OR
    (member_type = 'group'   AND group_id   IS NOT NULL AND chat_id    IS NULL AND contact_id IS NULL)
  ),
  UNIQUE (list_id, member_type, chat_id, contact_id, group_id)
);

CREATE INDEX idx_list_members_list ON list_members (list_id);
CREATE INDEX idx_list_members_chat ON list_members (chat_id) WHERE chat_id IS NOT NULL;
CREATE INDEX idx_list_members_contact ON list_members (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX idx_list_members_group ON list_members (group_id) WHERE group_id IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON list_members TO whatchatai_tenant;
ALTER TABLE list_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON list_members USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- One assignment per (list, agent). autonomy_override is restrict-only -
-- application code (listAgentAssignmentRepository.ts) rejects any value
-- greater than the agent's own ai_agents.autonomy_level on write; the CHECK
-- here is only the value-range backstop, since a CHECK can't see another
-- table's row. A List must only ever be able to make an agent MORE
-- conservative than its own configuration, never less - "never silently
-- increase autonomy."
CREATE TABLE list_agent_assignments (
  id                            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                   UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  list_id                       UUID        NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  agent_id                      UUID        NOT NULL REFERENCES ai_agents (id) ON DELETE CASCADE,
  enabled                       BOOLEAN     NOT NULL DEFAULT true,
  use_conversation_history      BOOLEAN     NOT NULL DEFAULT true,
  use_learn_profile             BOOLEAN     NOT NULL DEFAULT true,
  remember_list_specific_info   BOOLEAN     NOT NULL DEFAULT true,
  require_approval              BOOLEAN     NOT NULL DEFAULT false,
  autonomy_override             INTEGER     CHECK (autonomy_override IS NULL OR (autonomy_override BETWEEN 1 AND 5)),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (list_id, agent_id)
);

CREATE INDEX idx_list_agent_assignments_list ON list_agent_assignments (list_id) WHERE enabled = true;

GRANT SELECT, INSERT, UPDATE, DELETE ON list_agent_assignments TO whatchatai_tenant;
ALTER TABLE list_agent_assignments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON list_agent_assignments USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- THE hard-must isolation mechanism. Mirrors customer_memory's shape
-- exactly (migration 959) but keyed one level narrower:
-- (business_id, list_id, customer_id) instead of (business_id, customer_id).
-- The same real person (same customer_id) under two different list_ids is,
-- by construction, two disjoint rows with different primary keys - there is
-- no query shape anywhere in listScopedMemoryRepository.ts that can read
-- across list_id. This table does not replace customer_memory; it is a
-- sibling, consulted instead of it only for a conversation actively routed
-- through a List with remember_list_specific_info enabled.
CREATE TABLE list_scoped_memory (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id      UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  list_id          UUID        NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  customer_id      UUID        NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
  confirmed_facts  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  preferred_name   TEXT,
  version          INTEGER     NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, list_id, customer_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON list_scoped_memory TO whatchatai_tenant;
ALTER TABLE list_scoped_memory ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON list_scoped_memory USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- The 1:1 "which List currently governs routing for this chat" column,
-- mirroring assignee_user_id/assignee_team_id's own shape (migration 037) -
-- List MEMBERSHIP is many-to-many (list_members above), but only ever one
-- List is "in effect" for routing a given chat at a time. Nullable, set
-- only by an explicit action - never auto-guessed when more than one List
-- with a different enabled agent assignment applies to the same chat (see
-- listRoutingService.ts). A business that never uses Lists never sets this
-- column, so existing routing/behavior is completely unaffected.
ALTER TABLE whatsapp_chats ADD COLUMN active_list_id UUID REFERENCES lists (id) ON DELETE SET NULL;
CREATE INDEX idx_whatsapp_chats_active_list ON whatsapp_chats (active_list_id) WHERE active_list_id IS NOT NULL;

-- security_audit_logs.event_type - full restatement (996 was the last
-- migration to touch this constraint), extended with 8 new List event types.
ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked', 'lock_pin_changed',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled', 'campaign_deleted',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled', 'funnel_deleted',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed',
  'agent_updated',
  'message_revoke_requested', 'campaign_recalled', 'status_revoke_requested',
  'email_drafted', 'email_approved', 'email_sent', 'email_cancelled', 'email_settings_updated',
  'email_test_sent', 'goose_settings_updated', 'goose_tested',
  'ai_tool_invoked', 'ai_tool_denied',
  'ai_prompt_optimization_imported', 'ai_prompt_optimization_approved', 'ai_prompt_optimization_rejected',
  'business_document_uploaded', 'business_document_upload_blocked', 'business_document_deleted',
  'business_document_parsed', 'business_document_parse_failed',
  'writing_twin_learning_enabled', 'writing_twin_learning_disabled',
  'writing_twin_backfill_requested', 'writing_twin_deleted', 'writing_twin_profile_reset',
  'writing_twin_example_removed',
  'writing_twin_share_enabled', 'writing_twin_share_disabled',
  'writing_twin_agent_access_changed', 'writing_twin_profile_computed', 'writing_twin_context_served',
  'contact_privacy_updated', 'crm_contact_memory_erased',
  'handover_auto_reverted',
  'account_deletion_requested', 'account_deletion_cancelled', 'phone_number_changed',
  'ai_output_leak_blocked', 'ai_output_leak_check_unavailable',
  'message_risk_flagged',
  'plan_updated', 'plan_entitlement_updated', 'vertical_assigned',
  'platform_setting_updated',
  'subscription_plan_manually_changed',
  'bi_settings_enabled', 'bi_settings_disabled',
  'bi_insight_approved', 'bi_insight_rejected', 'bi_insight_held',
  'bi_security_alert_detected',
  'list_created', 'list_deleted',
  'list_agent_assigned', 'list_agent_unassigned',
  'list_membership_changed', 'list_active_list_set',
  'list_routed', 'list_scoped_memory_erased'
));
