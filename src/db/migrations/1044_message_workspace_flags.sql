-- What the operator decided about one message, inside AURA.
--
-- The same separation migration 1043 made for conversations, for the same
-- reason: whatsapp_messages is written by the ingestion path from what the
-- wire says, and anything an operator sets that shares a column with that
-- gets overwritten the next time WhatsApp reports otherwise.
--
-- Nothing here is pushed to WhatsApp. Starring a message in AURA does not
-- star it on the owner's phone, and the customer's app is untouched by
-- every one of these.
--
-- Per-business rather than per-user, deliberately. A pinned message is "the
-- thing this team needs to see in this conversation" - a delivery address, a
-- quoted price - and a pin only the person who made it can see is a note to
-- self, which is not what anybody reaches for a pin to do.

ALTER TABLE whatsapp_messages
  /* Kept for later, findable from one list across every conversation. */
  ADD COLUMN IF NOT EXISTS workspace_starred_at TIMESTAMPTZ,
  /* Held at the top of its own conversation. */
  ADD COLUMN IF NOT EXISTS workspace_pinned_at TIMESTAMPTZ,
  /* Who pinned it, so a pin somebody disagrees with has a person to ask. */
  ADD COLUMN IF NOT EXISTS workspace_pinned_by UUID REFERENCES users(id) ON DELETE SET NULL;

/* "Everything starred", which is a screen of its own and without this is a
   sequential scan of every message the business has ever exchanged. */
CREATE INDEX IF NOT EXISTS whatsapp_messages_workspace_starred_idx
  ON whatsapp_messages (business_id, workspace_starred_at DESC)
  WHERE workspace_starred_at IS NOT NULL;

/* The pins in one conversation - read on every thread open, so it has to be
   an index lookup rather than a scan of that chat's whole history. */
CREATE INDEX IF NOT EXISTS whatsapp_messages_workspace_pinned_idx
  ON whatsapp_messages (business_id, chat_id, workspace_pinned_at DESC)
  WHERE workspace_pinned_at IS NOT NULL;
