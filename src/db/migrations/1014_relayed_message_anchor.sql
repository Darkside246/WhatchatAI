-- Anchor each "Messages for you" entry to the message that caused it.
--
-- Clicking an entry on the board used to drop the operator at the live end
-- of the conversation, leaving them to scroll back and hunt for the thing
-- the AI had actually taken a message about - which is the opposite of what
-- a message board is for. With the anchor, the entry behaves like a
-- bookmark: it opens the conversation at that exact message.
--
-- Nullable, and ON DELETE SET NULL: an entry recorded before this column
-- existed genuinely has no anchor, and a message the customer later deletes
-- must not take the board entry (or its own conversation link) with it. In
-- both cases the board falls back to opening the conversation normally
-- rather than pointing at something that is not there.

ALTER TABLE relayed_messages
  ADD COLUMN IF NOT EXISTS message_id uuid REFERENCES whatsapp_messages(id) ON DELETE SET NULL;
