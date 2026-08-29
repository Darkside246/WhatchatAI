-- Provenance for a chat's ai_mode transition, so an automatic mechanism
-- (see the manual-reply-detected auto-pause/auto-resume below) can tell its
-- own transitions apart from a deliberate human dashboard action or a
-- separate AI-failure escalation - and never touch the latter two.
--
-- Nullable and unconstrained deliberately: every EXISTING row keeps working
-- with source = NULL (treated as "not mine" by anything that checks for a
-- specific source string), and this is diagnostic metadata, not a state
-- machine - it does not need a CHECK constraint enumerating every caller.
ALTER TABLE whatsapp_chats
  ADD COLUMN ai_mode_source TEXT,
  ADD COLUMN ai_mode_set_at TIMESTAMPTZ;
