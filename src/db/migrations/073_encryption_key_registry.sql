-- Singleton record of the master encryption key's own fingerprint
-- (masterKeyId - an HMAC of the key itself, never the key material). Lets
-- the app detect at boot that MASTER_ENCRYPTION_KEY has silently changed
-- since data was last encrypted, instead of discovering it later as
-- scattered AES-GCM auth failures deep in a queue worker.
CREATE TABLE encryption_key_registry (
  singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  key_id TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
