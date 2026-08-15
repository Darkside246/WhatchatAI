-- whatsapp_chats.last_message_id and whatsapp_messages.media_id were left
-- unconstrained when their tables were created because the referenced tables
-- (whatsapp_messages, whatsapp_media) didn't exist yet. Attach the real
-- constraints now that both sides exist.
ALTER TABLE whatsapp_chats
  ADD CONSTRAINT whatsapp_chats_last_message_id_fkey
  FOREIGN KEY (last_message_id) REFERENCES whatsapp_messages(id);

ALTER TABLE whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_media_id_fkey
  FOREIGN KEY (media_id) REFERENCES whatsapp_media(id);
