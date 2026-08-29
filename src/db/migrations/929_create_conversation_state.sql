-- Durable structured conversation state (Phase 2 of the identity/state/
-- gateway/action-bus roadmap). Additive: aiContextGathererService's raw
-- message-history/CRM/knowledge-base context gathering is completely
-- untouched by this table's existence - a conversation with no row here
-- simply has no structured state yet, and every existing chatId/contactId
-- resolution keeps working exactly as it does today.
--
-- One row per WhatsApp chat (the same conversation key already used
-- throughout the app), not per customer - a channel-agnostic conversation
-- key is a later, separate step once other channels actually exist.
CREATE TABLE conversation_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id),

  -- {description, setAt} or null - the AI's current understanding of what
  -- this conversation is trying to accomplish. Free-form JSON rather than a
  -- fixed set of columns since "goal" has no fixed schema across verticals.
  current_goal JSONB,

  -- Array of {key, value, origin, confirmedAt}. origin is constrained by
  -- the TypeScript ConversationFact type to 'user_confirmed' |
  -- 'system_confirmed' | 'external_verified' - there is deliberately no
  -- 'ai_inferred' option, so an unconfirmed AI guess has no valid shape to
  -- be written into this column as a "confirmed" fact.
  confirmed_facts JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Array of {id, question, openedAt, resolvedAt}.
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Reserved for Phase 3 (ActionBus production wiring) - an opaque JSON
  -- array nothing currently reads or writes. Included now so Phase 3 adds
  -- a consumer, not another migration.
  pending_actions JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Optimistic concurrency: every update must supply the version it read
  -- and CAS against it (UPDATE ... WHERE version = $N), the same pattern
  -- already proven in subscriptionRepository.ensureDefault(). A conflict
  -- means re-read, re-evaluate, retry - never a silent lost update.
  version INTEGER NOT NULL DEFAULT 1,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One structured-state row per conversation, ever.
CREATE UNIQUE INDEX conversation_states_chat_idx ON conversation_states (business_id, chat_id);
