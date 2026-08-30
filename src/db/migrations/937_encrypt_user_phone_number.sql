-- users.phone_number keeps its existing TEXT type - going forward it
-- stores a serialized EncryptedEnvelope (EncryptionService.serialize()),
-- the same envelope-in-a-TEXT-column pattern already used for OAuth
-- tokens (emailOAuthRepository.ts) and message text
-- (whatsappMessageRepository.ts). tryParse() returning null for
-- pre-existing plaintext rows lets reads fall back gracefully - no
-- backfill needed here, same convention those repositories already use.
--
-- phone_number_hash is the live-account dedup fingerprint (see
-- phoneFingerprint.ts) - used to check "is this number already claimed by
-- a different active account" on a phone-number change. Separate from
-- trial_phone_fingerprints (936), which must survive account deletion;
-- this column is cleared when its owning user row is anonymized at purge
-- time, same lifecycle as the phone number itself.
ALTER TABLE users ADD COLUMN phone_number_hash TEXT;
CREATE INDEX users_phone_number_hash_idx ON users (phone_number_hash)
  WHERE phone_number_hash IS NOT NULL AND deleted_at IS NULL;
