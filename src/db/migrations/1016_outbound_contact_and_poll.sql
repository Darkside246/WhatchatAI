-- Let the operator send the two non-media message types WhatsApp supports
-- natively but this app could not: a shared contact card, and a poll.
--
-- The attachment menu previously offered only a bare file picker, so an
-- operator who wanted to send someone a contact or ask a quick question had
-- to leave Aura and use their phone. Both are ordinary Baileys message
-- contents ({ contacts: ... } and { poll: ... }); the only thing missing was
-- somewhere to keep their structure between the request and the dispatch.
--
-- ENCRYPTED AT REST, same as whatsapp_messages.structured_payload: a shared
-- contact card carries a third party's name and phone number, and a poll
-- carries real business content. Stored as an AES-256-GCM envelope under
-- this tenant's own key, so a database dump without MASTER_ENCRYPTION_KEY
-- reveals neither.
--
-- text, not jsonb, precisely because it is encrypted - the value is an
-- opaque envelope, never something to index or query by.

ALTER TABLE whatsapp_outbound_messages
  ADD COLUMN IF NOT EXISTS structured_payload text;

-- The existing CHECK enumerates the allowed types, so it has to be replaced
-- rather than extended in place. Dropped and recreated with the two new
-- values plus every original one - no existing row can be invalidated,
-- since the old set is entirely contained in the new one.
ALTER TABLE whatsapp_outbound_messages
  DROP CONSTRAINT IF EXISTS whatsapp_outbound_messages_message_type_check;

ALTER TABLE whatsapp_outbound_messages
  ADD CONSTRAINT whatsapp_outbound_messages_message_type_check
  CHECK (message_type = ANY (ARRAY[
    'text'::text, 'image'::text, 'video'::text, 'audio'::text,
    'voice_note'::text, 'document'::text, 'contact'::text, 'poll'::text
  ]));
