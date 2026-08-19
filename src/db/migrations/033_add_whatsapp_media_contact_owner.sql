-- Profile pictures never had anywhere to attach a real downloaded file, even
-- though whatsapp_contacts.profile_picture_url and whatsapp_accounts.
-- profile_picture_url have existed since the original schema - nothing ever
-- wrote to them, because Baileys requires an explicit per-JID fetch call
-- (sock.profilePictureUrl(jid)), never pushed automatically. This adds a
-- third real owner to the same whatsapp_media table message/status media
-- already share, so profile pictures get the exact same encrypted-at-rest
-- storage and authenticated /api/media/:id serving as any other real media.
ALTER TABLE whatsapp_media
  ADD COLUMN contact_id UUID REFERENCES whatsapp_contacts(id);

ALTER TABLE whatsapp_media
  DROP CONSTRAINT whatsapp_media_owner_check;

ALTER TABLE whatsapp_media
  ADD CONSTRAINT whatsapp_media_owner_check
  CHECK (
    (CASE WHEN message_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN status_id IS NOT NULL THEN 1 ELSE 0 END) +
    (CASE WHEN contact_id IS NOT NULL THEN 1 ELSE 0 END) = 1
  );

CREATE INDEX whatsapp_media_contact_idx ON whatsapp_media (contact_id) WHERE contact_id IS NOT NULL;

-- Forward references to the one real, current profile picture - null until a
-- real fetch has actually succeeded, never a placeholder.
ALTER TABLE whatsapp_contacts
  ADD COLUMN profile_picture_media_id UUID REFERENCES whatsapp_media(id);

ALTER TABLE whatsapp_accounts
  ADD COLUMN profile_picture_media_id UUID REFERENCES whatsapp_media(id);
