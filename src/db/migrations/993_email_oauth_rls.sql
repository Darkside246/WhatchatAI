-- Email Redesign follow-up: Row-Level Security for email_oauth_messages
-- and email_oauth_folders - email_oauth_accounts already got RLS back in
-- migration 958_extend_row_level_security.sql (easy to miss - it's one
-- line in a long list of ALTER TABLE statements there, and this file's
-- first draft incorrectly re-applied it, which fails deterministically
-- with "policy already exists" on every database, fresh or not - found
-- and fixed before this shipped further). messages/folders never got
-- it, since they didn't exist (folders) or were overlooked (messages)
-- when 958 was written. Found while building the folder-sync rework;
-- deliberately deferred out of that change since it required converting
-- every call site in emailOAuthService.ts/emailSyncService.ts/
-- emailService.ts from the bare pool to queryAsTenant(businessId) - done
-- in this same change, so nothing here can silently start returning
-- zero rows.

-- email_oauth_messages and email_oauth_folders only ever had account_id,
-- not a direct business_id - RLS policies need a real column to filter
-- on, so both gain one here, backfilled from their owning account.

ALTER TABLE email_oauth_messages ADD COLUMN business_id UUID REFERENCES businesses (id) ON DELETE CASCADE;
UPDATE email_oauth_messages m SET business_id = a.business_id FROM email_oauth_accounts a WHERE a.id = m.account_id;
ALTER TABLE email_oauth_messages ALTER COLUMN business_id SET NOT NULL;
CREATE INDEX idx_email_oauth_messages_business ON email_oauth_messages (business_id);

ALTER TABLE email_oauth_folders ADD COLUMN business_id UUID REFERENCES businesses (id) ON DELETE CASCADE;
UPDATE email_oauth_folders f SET business_id = a.business_id FROM email_oauth_accounts a WHERE a.id = f.account_id;
ALTER TABLE email_oauth_folders ALTER COLUMN business_id SET NOT NULL;
CREATE INDEX idx_email_oauth_folders_business ON email_oauth_folders (business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_oauth_messages TO whatchatai_tenant;
ALTER TABLE email_oauth_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_oauth_messages USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_oauth_folders TO whatchatai_tenant;
ALTER TABLE email_oauth_folders ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_oauth_folders USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- sweepEmailOAuthSync() (emailSyncService.ts) is the one deliberately
-- tenant-agnostic caller left on the bare pool (same reasoning as
-- writingTwinRepository.ts's own sweepExpiredRawEvents) - it genuinely
-- needs every business's sync-enabled accounts at once, and the
-- whatchatai app role (not whatchatai_tenant) is unaffected by this
-- policy, matching every other RLS'd table's own escape hatch for real
-- platform-wide sweeps.
