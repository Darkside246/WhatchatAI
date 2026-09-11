-- Keep the real content of the non-media message types.
--
-- Location, shared-contact and poll messages were already classified
-- correctly, but only their TYPE was stored - so the operator could see
-- that "a location" had arrived without ever seeing where, or that "a poll"
-- had arrived without seeing what it asked. The detail WhatsApp actually
-- sent was parsed and then thrown away.
--
-- ENCRYPTED AT REST, exactly like whatsapp_messages.text_content: this
-- column holds a customer's precise coordinates, a third party's name and
-- phone number from a shared contact card, and poll content - all personal
-- data, and a location is among the most sensitive of it. Stored as an
-- AES-256-GCM envelope under this tenant's own HKDF-derived key, so a
-- database dump without MASTER_ENCRYPTION_KEY reveals none of it.
--
-- text, not jsonb, precisely because it is encrypted: the value is an
-- opaque envelope, never something to index or query by. Nothing in the
-- application filters on it - it is read back for one message at a time and
-- decrypted for display.
--
-- Nullable: the overwhelming majority of messages (text, images, video,
-- documents) carry no structured payload at all, and a historical row from
-- before this column existed honestly has none rather than an empty object
-- pretending to be one.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS structured_payload text;
