CREATE TABLE whatsapp_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  call_id TEXT NOT NULL,
  remote_jid TEXT NOT NULL,
  remote_phone_number TEXT,

  call_type TEXT NOT NULL CHECK (call_type IN ('voice', 'video', 'unknown')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status TEXT NOT NULL CHECK (status IN (
    'offer', 'ringing', 'accepted', 'rejected', 'missed', 'timeout', 'ended', 'unknown'
  )),

  is_video BOOLEAN NOT NULL DEFAULT false,
  is_group BOOLEAN NOT NULL DEFAULT false,

  started_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  duration_seconds INTEGER,

  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A call event stream can update the same call (offer -> ringing -> ended);
-- this keeps repeated events for one real call as one row instead of duplicates.
CREATE UNIQUE INDEX whatsapp_calls_identity_idx
  ON whatsapp_calls (business_id, whatsapp_account_id, call_id);
