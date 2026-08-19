-- Phase B3: Teams, conversation assignment, and agent capacity - the
-- structured human-to-human axis alongside the existing AI-vs-human
-- ai_mode column, now possible because real multi-user auth (Phase B1)
-- exists to assign conversations to.

CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, name)
);

CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE INDEX idx_team_members_user ON team_members (user_id);

-- Per-conversation human assignment - deliberately columns on the real,
-- existing whatsapp_chats row (never a second "conversation" table; see
-- the Chatwoot capability gap audit's Data Model section).
ALTER TABLE whatsapp_chats
  ADD COLUMN assignee_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN assignee_team_id UUID REFERENCES teams(id) ON DELETE SET NULL;

CREATE INDEX idx_whatsapp_chats_assignee_user ON whatsapp_chats (assignee_user_id) WHERE assignee_user_id IS NOT NULL;

-- Real per-agent capacity. "Active" conversations are simply "currently
-- assigned to this user" - there is no conversation resolve/snooze state
-- machine yet (Chatwoot gap audit section 2, Phase A, not built), so this
-- is an honest approximation, not a fabricated workload metric.
CREATE TABLE agent_capacity (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  max_active_conversations INTEGER NOT NULL DEFAULT 20,
  availability TEXT NOT NULL DEFAULT 'available' CHECK (availability IN ('available', 'busy', 'offline')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
