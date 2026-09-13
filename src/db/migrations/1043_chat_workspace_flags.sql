-- What the operator decided about a conversation, inside AURA.
--
-- Deliberately NOT the existing is_archived / is_pinned / is_muted columns.
-- Those are WhatsApp's own view of the chat, written by the history sync
-- (whatsappSyncService.ts reads chat.archived and chat.pinned straight off
-- the wire), and the upsert COALESCEs them on every sync. An operator
-- archiving a chat in this workspace would have been silently un-archived
-- the next time WhatsApp reported otherwise - a setting that quietly undoes
-- itself is worse than no setting.
--
-- So these are separate, and they mean something different: "what the
-- person using AURA wants this workspace to do", never "what the WhatsApp
-- account thinks". Nothing here is pushed to WhatsApp. The customer's own
-- app is untouched by every one of them.
--
-- Timestamps rather than booleans throughout. "Pinned" and "when it was
-- pinned" cost the same to store, and the second answers a question the
-- first cannot: pin order, and how long something has been sitting archived.

ALTER TABLE whatsapp_chats
  /* Out of the main list, still fully readable. */
  ADD COLUMN IF NOT EXISTS workspace_archived_at TIMESTAMPTZ,
  /* To the top, newest pin first. */
  ADD COLUMN IF NOT EXISTS workspace_pinned_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS workspace_favorited_at TIMESTAMPTZ,
  /* NULL is not muted. A far-future date is "until I say otherwise" - one
     column rather than a boolean plus a date, so there is no state where the
     two disagree about whether a chat is muted. */
  ADD COLUMN IF NOT EXISTS workspace_muted_until TIMESTAMPTZ,
  /* Deliberately left unread by a person, after it was already read. Cleared
     the moment they actually open it - see the repository. */
  ADD COLUMN IF NOT EXISTS workspace_marked_unread_at TIMESTAMPTZ;

/* The inbox's own ordering: pinned first, then everything not archived.
   Partial, because the archived rows are exactly the ones this index should
   not carry. */
CREATE INDEX IF NOT EXISTS whatsapp_chats_workspace_inbox_idx
  ON whatsapp_chats (business_id, workspace_pinned_at DESC NULLS LAST, last_message_at DESC NULLS LAST)
  WHERE deleted_at IS NULL AND workspace_archived_at IS NULL;

/* "What is archived" is its own screen, and without this it is a sequential
   scan of every conversation the business has ever had. */
CREATE INDEX IF NOT EXISTS whatsapp_chats_workspace_archived_idx
  ON whatsapp_chats (business_id, workspace_archived_at DESC)
  WHERE deleted_at IS NULL AND workspace_archived_at IS NOT NULL;
