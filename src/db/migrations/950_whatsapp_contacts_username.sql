-- WhatsApp's own "username" feature (an @handle a contact can set instead
-- of just showing their phone-derived push name) - Baileys' Contact type
-- already exposes this as `username`, distinct from `notify` (pushName)
-- and `verifiedName`.
ALTER TABLE whatsapp_contacts ADD COLUMN username TEXT;
