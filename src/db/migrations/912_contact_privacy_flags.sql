ALTER TABLE crm_contacts
  ADD COLUMN is_hidden BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN sync_excluded BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN ai_excluded BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX crm_contacts_privacy_idx ON crm_contacts (business_id, is_hidden)
  WHERE deleted_at IS NULL;
