CREATE TABLE whatsapp_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id),

  whatsapp_message_id TEXT NOT NULL,
  remote_jid TEXT NOT NULL,
  sender_jid TEXT NOT NULL,
  recipient_jid TEXT,

  sender_contact_id UUID REFERENCES whatsapp_contacts(id),
  recipient_contact_id UUID REFERENCES whatsapp_contacts(id),

  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_type TEXT NOT NULL CHECK (message_type IN (
    'text', 'image', 'audio', 'voice_note', 'video', 'document', 'spreadsheet',
    'sticker', 'location', 'contact', 'contacts', 'reaction', 'poll',
    'poll_response', 'button', 'interactive', 'system', 'call_event', 'unknown'
  )),

  text_content TEXT,
  caption TEXT,
  quoted_message_id UUID REFERENCES whatsapp_messages(id),

  "timestamp" TIMESTAMPTZ NOT NULL,
  from_me BOOLEAN NOT NULL,
  is_historical BOOLEAN NOT NULL DEFAULT false,

  status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (status IN ('pending', 'sent', 'delivered', 'read', 'played', 'failed', 'unknown')),

  has_media BOOLEAN NOT NULL DEFAULT false,
  -- No FK yet: whatsapp_media references this table. 010_add_cross_table_foreign_keys.sql
  -- attaches the real constraint once whatsapp_media exists.
  media_id UUID,

  raw_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

-- Database-level duplicate protection: the same WhatsApp message can never be
-- inserted twice for the same account, regardless of application-level races.
CREATE UNIQUE INDEX whatsapp_messages_identity_idx
  ON whatsapp_messages (business_id, whatsapp_account_id, whatsapp_message_id);

CREATE INDEX whatsapp_messages_chat_timestamp_idx
  ON whatsapp_messages (chat_id, "timestamp" DESC);

CREATE INDEX whatsapp_messages_text_search_idx
  ON whatsapp_messages USING gin (to_tsvector('simple', coalesce(text_content, '')))
  WHERE deleted_at IS NULL;
