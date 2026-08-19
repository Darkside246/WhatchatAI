-- Status media (photos/videos posted to status@broadcast) never had anywhere
-- to attach a real downloaded file - whatsapp_media.message_id was NOT NULL,
-- so status media could only ever be honestly reported as unavailable
-- (mediaAvailable: false), never actually downloaded. A status is
-- deliberately never inserted into whatsapp_messages (see
-- 013_create_whatsapp_statuses.sql), so this adds a second, equally valid
-- owner column rather than forcing statuses through the message table.
ALTER TABLE whatsapp_media
  ALTER COLUMN message_id DROP NOT NULL,
  ADD COLUMN status_id UUID REFERENCES whatsapp_statuses(id);

-- Every media row belongs to exactly one real owner - never both, never neither.
ALTER TABLE whatsapp_media
  ADD CONSTRAINT whatsapp_media_owner_check
  CHECK ((message_id IS NOT NULL) <> (status_id IS NOT NULL));

CREATE INDEX whatsapp_media_status_idx ON whatsapp_media (status_id) WHERE status_id IS NOT NULL;
