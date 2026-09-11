-- Record WhatsApp's own forwarding metadata on each message.
--
-- The agent needs to know that a customer FORWARDED something from another
-- chat rather than writing it here, because the two call for different
-- replies: a forwarded price list or a forwarded chain message is not the
-- sender speaking in their own voice, and treating it as a direct request
-- produces a confidently wrong answer.
--
-- Both columns come straight off WhatsApp's contextInfo envelope
-- (isForwarded, forwardingScore) - never inferred from the message text,
-- which would be guessing. forwarding_score counts how many hops a message
-- has travelled; WhatsApp's own client labels >= 5 "forwarded many times".
--
-- Nullable/defaulted so every historical row stays valid: an existing
-- message predating this migration is honestly "not known to be forwarded"
-- (false), not retroactively claimed to be one.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS is_forwarded boolean NOT NULL DEFAULT false;

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS forwarding_score integer;
