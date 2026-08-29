-- Append-only conversation event stream (Phase 2, part 2). Independently
-- understandable from platform_audit_events (901_platform_runtime.sql) -
-- a conversation domain event is not an administrative audit event, and
-- this table is not read or written by AuditLedgerService. It reuses only
-- the proven *engineering principles* (DB-computed sequence, hash chain,
-- append-only, tenant-scoped), not the code or the table.
--
-- event_type is a closed CHECK list mirroring the ConversationEventType
-- union in conversationEventRepository.ts exactly - the two must be kept
-- in sync by hand. (See migration 927's fix for what happens when a CHECK
-- list and its TypeScript union silently drift apart over many migrations
-- - this list should be replaced wholesale, in one migration, if it ever
-- needs to grow, never incrementally ORed onto.)
CREATE TABLE conversation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id),

  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'conversation_created',
    'message_received',
    'message_sent',
    'goal_updated',
    'fact_confirmed',
    'question_opened',
    'question_resolved',
    'state_updated',
    'channel_session_started',
    'channel_session_ended',
    'handoff_requested',
    'action_proposed',
    'action_approved',
    'action_executed'
  )),

  -- Structured references and metadata only - e.g. {"messageId": "..."} for
  -- message_received/message_sent, never the raw message text (that
  -- already lives durably in whatsapp_messages; duplicating it here would
  -- be an unnecessary second copy of potentially sensitive content).
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_hash TEXT NOT NULL,
  previous_hash TEXT,

  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Strict per-conversation ordering, and the append path's own uniqueness
-- guarantee: two events for the same (business, chat) can never claim the
-- same sequence number.
CREATE UNIQUE INDEX conversation_events_sequence_idx ON conversation_events (business_id, chat_id, sequence);
CREATE INDEX conversation_events_chat_idx ON conversation_events (business_id, chat_id, occurred_at);
