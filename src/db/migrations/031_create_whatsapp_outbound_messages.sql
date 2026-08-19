-- Tracks a human-initiated send request as its own lifecycle, separate from
-- whatsapp_messages: a send request exists (and can be idempotency-deduped,
-- retried, marked failed) before WhatsApp has ever assigned it a real
-- message id. Once send actually succeeds, Baileys echoes the sent message
-- back through the normal messages.upsert -> incoming_messages pipeline
-- (fromMe: true), which persists it into whatsapp_messages exactly like any
-- other message - this table never duplicates that persistence, it only
-- tracks the dispatch attempt itself.
CREATE TABLE whatsapp_outbound_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id),
  to_jid TEXT NOT NULL,

  -- Caller-supplied (or server-generated) key. A retried API call with the
  -- same key must never enqueue a second real WhatsApp send.
  idempotency_key TEXT NOT NULL,

  message_type TEXT NOT NULL CHECK (message_type IN ('text', 'image', 'video', 'audio', 'document')),
  text_content TEXT,
  caption TEXT,

  -- Set only for media types - the same tenant-scoped, AES-256-GCM
  -- encrypted-at-rest storage used for inbound media (localEncryptedMediaStorage.ts).
  media_storage_reference TEXT,
  media_mime_type TEXT,
  media_file_name TEXT,

  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sending', 'sent', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,

  -- Set once WhatsApp actually accepts the send and assigns a real message id.
  whatsapp_message_id TEXT,
  -- Backfilled once the echoed messages.upsert event persists the real row -
  -- may briefly lag behind status = 'sent', since that persistence is async.
  message_id UUID REFERENCES whatsapp_messages(id),

  -- No user/auth system exists yet (single-operator dev model) - this
  -- documents that only a human-initiated API call may ever create a row
  -- here. Nothing in this phase gives the AI layer a path to this table.
  requested_by TEXT NOT NULL DEFAULT 'human',

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX whatsapp_outbound_messages_idempotency_idx
  ON whatsapp_outbound_messages (business_id, whatsapp_account_id, idempotency_key);

CREATE INDEX whatsapp_outbound_messages_chat_idx
  ON whatsapp_outbound_messages (chat_id, created_at DESC);

-- The stale-job sweep (mirrors the sync-job and call-timeout sweeps) scans
-- exactly this partial index for anything wedged in a non-terminal state.
CREATE INDEX whatsapp_outbound_messages_pending_idx
  ON whatsapp_outbound_messages (status, updated_at) WHERE status IN ('queued', 'sending');
