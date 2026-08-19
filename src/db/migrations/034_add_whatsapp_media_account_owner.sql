-- The connected WhatsApp account's own profile picture ("my profile photo")
-- needs the exact same real, encrypted-at-rest media pipeline contact photos
-- just got in 033 - adding a fourth real owner rather than inventing a
-- separate storage/serving path for what is, structurally, the same kind of
-- real downloaded image.
ALTER TABLE whatsapp_media
  ADD COLUMN account_id UUID REFERENCES whatsapp_accounts(id);

ALTER TABLE whatsapp_media
  DROP CONSTRAINT whatsapp_media_owner_check;

ALTER TABLE whatsapp_media
  ADD CONSTRAINT whatsapp_media_owner_check
  CHECK (
    (CASE WHEN message_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN status_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN account_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

CREATE INDEX whatsapp_media_account_idx ON whatsapp_media (account_id) WHERE account_id IS NOT NULL;
