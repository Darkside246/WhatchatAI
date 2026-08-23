-- Phase 3B: trailing-edge AI message debouncing (see
-- docs/PHASE_3A_AI_RELIABILITY_AUDIT_AND_PROPOSAL.md section 5). The
-- debounce BullMQ job itself is only ever a "check now" signal, never the
-- authoritative source of what to reply to - these two columns are that
-- authoritative state, read and written directly against Postgres so a
-- duplicate/stale job delivery, a worker crash, or a rapid message burst
-- can never produce a duplicate AI reply or lose a message.
ALTER TABLE whatsapp_chats
  ADD COLUMN last_ai_handoff_message_id UUID REFERENCES whatsapp_messages(id),
  ADD COLUMN ai_handoff_claimed_at TIMESTAMPTZ;

-- Backs both the per-chat "unanswered since" lookup (processAiDebounce)
-- and the crash-recovery/backstop sweep's full scan
-- (findAiActiveChatsWithUnansweredMessages) - a partial index matching
-- exactly the rows either query ever touches, mirroring the Phase 2B
-- whatsapp_media_downloading_idx convention.
CREATE INDEX whatsapp_messages_unanswered_idx ON whatsapp_messages (chat_id, created_at)
  WHERE from_me = false AND is_historical = false AND has_media = false AND deleted_at IS NULL;
