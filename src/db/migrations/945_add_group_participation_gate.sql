-- Group-chat participation gate: per-chat override for the algorithmic
-- gate in groupParticipationGate.ts, mirroring ai_mode/ai_mode_source's
-- provenance pattern (933_add_chat_ai_mode_source.sql). AUTO is the real
-- scored algorithm; the other three are deliberate escape hatches (e.g.
-- a small internal ops group that always wants a reply). Meaningless for
-- is_group = false chats - never read for a DM.
ALTER TABLE whatsapp_chats
  ADD COLUMN group_participation_mode TEXT NOT NULL DEFAULT 'AUTO'
    CHECK (group_participation_mode IN ('AUTO', 'MENTIONS_ONLY', 'ALWAYS_ON', 'OFF')),
  ADD COLUMN group_participation_mode_source TEXT,
  ADD COLUMN group_participation_mode_set_at TIMESTAMPTZ,
  -- Cooldown watermark: "last time the AI actually SENT a group reply" -
  -- independent of last_ai_handoff_message_id/ai_handoff_claimed_at,
  -- which track "considered," not "spoke."
  ADD COLUMN last_ai_group_reply_at TIMESTAMPTZ;
