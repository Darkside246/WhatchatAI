-- Per-conversation AI/human-takeover state. Belongs to the chat, not globally
-- to the account: one conversation can be handed to a human while others stay
-- AI-driven.
ALTER TABLE whatsapp_chats
  ADD COLUMN ai_mode TEXT NOT NULL DEFAULT 'AI_ACTIVE'
    CHECK (ai_mode IN ('AI_ACTIVE', 'AI_PAUSED', 'HUMAN_TAKEOVER'));
