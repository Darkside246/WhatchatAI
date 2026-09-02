-- Layer 2 of "layered memory": durable facts scoped to a CUSTOMER (the
-- channel-agnostic identity migration 928 already resolves), not just one
-- conversation. conversation_states (migration 929) is layer 1 - facts
-- confirmed in one chat that don't survive past it. This table is the base
-- layer beneath it: a returning customer's confirmed facts (e.g. "unit
-- number", "preferred contact time") carry across every conversation they
-- ever have with this business, on any chat.
--
-- Deliberately facts-only - no current_goal/open_questions here. A "goal"
-- is a genuinely per-conversation concept (what they're trying to
-- accomplish *right now*); carrying one across unrelated future
-- conversations would be actively wrong, not just unnecessary scope.
CREATE TABLE customer_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID NOT NULL REFERENCES businesses(id),
  customer_id   UUID NOT NULL REFERENCES customers(id),

  -- Same {key, value, origin, confirmedAt} shape as conversation_states'
  -- confirmed_facts (see conversationStateRepository.ts's ConversationFact
  -- type) - deliberately reused, not reinvented, so both layers share one
  -- write-through path and one set of provenance rules (no 'ai_inferred'
  -- origin here either).
  confirmed_facts JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Same optimistic-concurrency pattern as conversation_states.version.
  version       INTEGER NOT NULL DEFAULT 1,

  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One memory row per customer, ever.
CREATE UNIQUE INDEX customer_memory_customer_idx ON customer_memory (business_id, customer_id);
