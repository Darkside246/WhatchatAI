-- Email Redesign Phase A: real per-folder discovery for connected
-- Gmail/Outlook inboxes. Before this, email_oauth_messages.folder was a
-- plain TEXT column the sync code guessed from labelIds - and Gmail's
-- sync query was hardcoded to `in:inbox ...`, so the code path that
-- tagged a message 'SENT' could never actually fire (Sent mail was never
-- fetched in the first place). This migration replaces that guess with a
-- real, discovered-from-the-provider folder table; emailSyncService.ts's
-- accompanying rework fetches per-folder instead of one hardcoded query.

CREATE TABLE email_oauth_folders (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                UUID        NOT NULL REFERENCES email_oauth_accounts (id) ON DELETE CASCADE,
  -- The provider's own folder/label id (a Gmail label id like 'INBOX' or
  -- 'Label_123', or an Outlook mailFolder id) - never invented here.
  provider_folder_id        TEXT        NOT NULL,
  display_name              TEXT        NOT NULL,
  well_known_type           TEXT        NOT NULL DEFAULT 'other'
                                         CHECK (well_known_type IN ('inbox', 'sent', 'drafts', 'spam', 'trash', 'archive', 'other')),
  -- The provider's own parent folder id, for Outlook's nested folders -
  -- stored as raw provider data for display grouping, not a real FK (a
  -- child folder can be discovered before its parent in a paginated list).
  parent_provider_folder_id TEXT,
  sync_cursor               TEXT,
  last_synced_at            TIMESTAMPTZ,
  unread_count              INTEGER     NOT NULL DEFAULT 0,
  total_count               INTEGER     NOT NULL DEFAULT 0,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (account_id, provider_folder_id)
);

CREATE INDEX idx_email_oauth_folders_account ON email_oauth_folders (account_id);

-- Real per-folder linkage, replacing the old plain TEXT column.
ALTER TABLE email_oauth_messages ADD COLUMN folder_id UUID REFERENCES email_oauth_folders (id) ON DELETE CASCADE;

-- Backfill: synthesize one folder row per distinct (account_id, folder)
-- pair already present (their existing values, 'INBOX'/'SENT', are
-- literally valid Gmail label ids), so no already-synced message is
-- orphaned by this change.
INSERT INTO email_oauth_folders (account_id, provider_folder_id, display_name, well_known_type)
SELECT DISTINCT account_id, folder, INITCAP(LOWER(folder)),
  CASE WHEN folder = 'SENT' THEN 'sent' WHEN folder = 'INBOX' THEN 'inbox' ELSE 'other' END
FROM email_oauth_messages
ON CONFLICT (account_id, provider_folder_id) DO NOTHING;

UPDATE email_oauth_messages m
SET folder_id = f.id
FROM email_oauth_folders f
WHERE f.account_id = m.account_id AND f.provider_folder_id = m.folder;

ALTER TABLE email_oauth_messages ALTER COLUMN folder_id SET NOT NULL;
ALTER TABLE email_oauth_messages DROP COLUMN folder;

-- Gmail messages genuinely have multi-folder membership (a message can
-- carry both INBOX and a custom label simultaneously; Outlook's model is
-- strictly single-folder, a degenerate case of the same shape) - so the
-- real uniqueness key is (account, folder, provider message), not just
-- (account, provider message). The same provider message legitimately
-- gets one row per real folder it belongs to when synced that way.
DROP INDEX idx_email_oauth_msgs_provider_msg;
CREATE UNIQUE INDEX idx_email_oauth_msgs_folder_provider_msg
  ON email_oauth_messages (account_id, folder_id, provider_message_id);

CREATE INDEX idx_email_oauth_msgs_folder ON email_oauth_messages (folder_id, received_at DESC NULLS LAST);

-- NOTE: neither email_oauth_accounts nor email_oauth_messages has Row-
-- Level Security today (a real, pre-existing gap versus the tenant_isolation
-- convention migrations 944/960/980/990 established) - every repository
-- method here already filters explicitly by account_id/business_id in its
-- WHERE clause, which is this subsystem's real current protection. Adding
-- RLS to just the new email_oauth_folders table in this migration without
-- also retrofitting its two siblings (and converting every call site from
-- the bare pool to queryAsTenant(), which they don't use today) would be
-- an inconsistent half-fix with a real risk of silently hiding rows if a
-- call site is missed - deliberately left for a dedicated follow-up pass
-- across the whole email_oauth_* subsystem instead.
