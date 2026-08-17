-- Phase B8: a real WhatsApp-first sales funnel engine. Node types are
-- deliberately limited to the ones with a genuine, already-built backend
-- action behind them (message send, human/team assignment, CRM tag/stage
-- update, notification, a real timed wait) - per the directive's own rule
-- "only expose nodes whose backend action exists." AI-agent nodes,
-- interactive question-capture, tasks, appointments, documents, and
-- webhooks are NOT included here because no real backend for them exists
-- yet; adding a node type to the CHECK constraint below without a real
-- executor behind it in funnelService.ts would be exactly the kind of
-- placeholder this project's discipline forbids.
--
-- The step LIST below (ordered, linear-with-branching via CONDITION) is
-- the real functional equivalent of the directive's drag-and-drop canvas -
-- a full visual node-graph editor is a distinct, large frontend investment
-- deferred to a later pass; every step here still executes for real.
CREATE TABLE funnel_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE funnel_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  funnel_id UUID NOT NULL REFERENCES funnel_definitions(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  node_type TEXT NOT NULL CHECK (node_type IN (
    'MESSAGE', 'WAIT', 'CONDITION', 'ASSIGN_HUMAN', 'ASSIGN_TEAM', 'ADD_TAG', 'REMOVE_TAG', 'UPDATE_STAGE', 'NOTIFY_USER'
  )),
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (funnel_id, position)
);

-- One real, running/finished journey per (funnel, contact) - never a
-- second concurrent instance for the same contact in the same funnel.
CREATE TABLE funnel_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  funnel_id UUID NOT NULL REFERENCES funnel_definitions(id) ON DELETE CASCADE,
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  crm_contact_id UUID NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  current_position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'WAITING', 'COMPLETED', 'FAILED', 'CANCELLED')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (funnel_id, crm_contact_id)
);

CREATE INDEX idx_funnel_steps_funnel ON funnel_steps (funnel_id, position);
CREATE INDEX idx_funnel_instances_funnel ON funnel_instances (funnel_id);
CREATE INDEX idx_funnel_instances_business ON funnel_instances (business_id);
