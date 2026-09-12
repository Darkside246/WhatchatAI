-- Who actually watched a Status we posted.
--
-- whatsapp_statuses.view_count already held WhatsApp's own number, which
-- answers "how many" and nothing else. "Which of my customers watched the
-- thing I posted yesterday" is a different and far more useful question -
-- it is the one piece of real engagement data a WhatsApp-first business
-- gets back from a broadcast, and it was being thrown away.
--
-- WhatsApp does send it: a status view arrives as an ordinary read receipt
-- on status@broadcast naming the viewer. Nothing was listening for it.
--
-- Keyed on WhatsApp's own status id as TEXT rather than a foreign key,
-- because a receipt names the status by that id and two different tables
-- can hold the row it belongs to (whatsapp_statuses for anything observed,
-- scheduled_statuses for something this business published). Resolving
-- which at write time would mean a lookup on a hot event path, and a
-- receipt for a status we no longer keep a row for is still true.

CREATE TABLE IF NOT EXISTS whatsapp_status_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  whatsapp_account_id uuid NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,

  /* WhatsApp's own message id for the status, matching
     scheduled_statuses.published_whatsapp_message_id and
     whatsapp_statuses.status_id. */
  status_whatsapp_id text NOT NULL,

  /* The viewer. A real JID WhatsApp sent us, never inferred - resolved to a
     name at read time through the same resolver the inbox uses, rather than
     denormalised here where it would go stale. */
  viewer_jid text NOT NULL,

  /* WhatsApp's own read timestamp when it sent one, else when we heard. */
  viewed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per person per status. WhatsApp re-sends receipts (a reconnect
-- replays them), and a viewer counted twice would quietly inflate the only
-- engagement number this feature produces.
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_status_views_identity_idx
  ON whatsapp_status_views (business_id, whatsapp_account_id, status_whatsapp_id, viewer_jid);

-- The read path: every viewer of one status, newest first.
CREATE INDEX IF NOT EXISTS whatsapp_status_views_status_idx
  ON whatsapp_status_views (business_id, status_whatsapp_id, viewed_at DESC);

-- Same tenant backstop as every other tenant-scoped table - see migration
-- 958 for why this binds only queryAsTenant()'s restricted role.
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_status_views TO whatchatai_tenant;
ALTER TABLE whatsapp_status_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON whatsapp_status_views;
CREATE POLICY tenant_isolation ON whatsapp_status_views
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
