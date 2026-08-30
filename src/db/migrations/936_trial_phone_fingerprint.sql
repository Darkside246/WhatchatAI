-- Permanent, hash-only phone fingerprint for trial-abuse dedup (see
-- phoneFingerprint.ts). Deliberately has NO foreign key to users/
-- businesses/trial_identities, so it is never touched by any ON DELETE
-- CASCADE - it must outlive the account it was recorded for, so a deleted
-- trial can't be replayed under a fresh email on the same real phone
-- number. Holds a one-way HMAC-SHA256 hash only, never the phone number
-- itself - the same already-shipped fraud-prevention exception
-- trial_identities.email already applies (that table is likewise never
-- cleared on account deletion), extended here to phone.
CREATE TABLE trial_phone_fingerprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
