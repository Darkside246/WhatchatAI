CREATE TABLE whatsapp_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),

  account_name TEXT,

  whatsapp_jid TEXT,
  jid_kind TEXT NOT NULL DEFAULT 'unknown'
    CHECK (jid_kind IN ('individual', 'lid', 'group', 'broadcast', 'newsletter', 'unknown')),
  phone_number TEXT,

  push_name TEXT,
  profile_name TEXT,
  profile_picture_url TEXT,
  about_text TEXT,

  connection_status TEXT NOT NULL DEFAULT 'DISCONNECTED'
    CHECK (connection_status IN (
      'DISCONNECTED', 'CONNECTING', 'QR_READY', 'CONNECTED',
      'RECONNECTING', 'LOGGED_OUT', 'ERROR'
    )),
  connected_at TIMESTAMPTZ,
  last_connected_at TIMESTAMPTZ,
  last_disconnected_at TIMESTAMPTZ,
  last_message_at TIMESTAMPTZ,

  sync_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (sync_status IN ('not_started', 'in_progress', 'completed', 'failed')),
  sync_started_at TIMESTAMPTZ,
  sync_completed_at TIMESTAMPTZ,
  sync_progress NUMERIC(5, 2),
  last_sync_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- One live account per JID per business. Partial index so a re-linked account
-- (new row after logout/re-pair) never collides with a soft-deleted one.
CREATE UNIQUE INDEX whatsapp_accounts_business_jid_idx
  ON whatsapp_accounts (business_id, whatsapp_jid)
  WHERE whatsapp_jid IS NOT NULL AND deleted_at IS NULL;
