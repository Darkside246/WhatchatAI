CREATE TABLE whatsapp_connection_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  event_type TEXT NOT NULL CHECK (event_type IN (
    'connecting', 'qr_generated', 'connected', 'disconnected', 'reconnecting', 'logged_out', 'error'
  )),
  status TEXT NOT NULL,

  phone_number TEXT,
  jid TEXT,
  push_name TEXT,

  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  reconnect_attempt INTEGER,
  error_code TEXT,
  error_message TEXT,

  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX whatsapp_connection_events_account_idx
  ON whatsapp_connection_events (whatsapp_account_id, started_at DESC);
