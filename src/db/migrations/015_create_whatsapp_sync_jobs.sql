CREATE TABLE whatsapp_sync_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  sync_type TEXT NOT NULL CHECK (sync_type IN (
    'initial', 'history', 'contacts', 'chats', 'groups', 'messages',
    'media', 'incremental', 'repair', 'on_demand'
  )),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),

  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  progress_percent NUMERIC(5, 2),

  chats_processed INTEGER NOT NULL DEFAULT 0,
  contacts_processed INTEGER NOT NULL DEFAULT 0,
  groups_processed INTEGER NOT NULL DEFAULT 0,
  messages_processed INTEGER NOT NULL DEFAULT 0,
  media_processed INTEGER NOT NULL DEFAULT 0,
  errors_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX whatsapp_sync_jobs_account_idx
  ON whatsapp_sync_jobs (whatsapp_account_id, created_at DESC);
