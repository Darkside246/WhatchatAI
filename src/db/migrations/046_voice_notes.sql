-- Real WhatsApp voice notes (PTT), as distinct from sending an audio file.
--
-- These are genuinely different things on WhatsApp: a voice note renders as
-- a waveform with a play head and is marked ptt=true on the wire, while an
-- audio file renders as an attachment. Sending a recording as 'audio' - which
-- is all this app could do before - produces the wrong thing in the
-- recipient's chat, so the type has to be carried end to end rather than
-- inferred from the mime type.
ALTER TABLE whatsapp_outbound_messages
  DROP CONSTRAINT whatsapp_outbound_messages_message_type_check;

ALTER TABLE whatsapp_outbound_messages
  ADD CONSTRAINT whatsapp_outbound_messages_message_type_check
  CHECK (message_type IN ('text', 'image', 'video', 'audio', 'voice_note', 'document'));

-- The real measured duration of the recording, read back from the encoded
-- file by ffprobe after transcoding - never a value the browser guessed or
-- the UI counted. NULL when it genuinely could not be determined.
ALTER TABLE whatsapp_outbound_messages
  ADD COLUMN media_duration_seconds INTEGER;
