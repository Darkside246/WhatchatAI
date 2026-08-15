CREATE TABLE whatsapp_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id),
  whatsapp_account_id UUID NOT NULL REFERENCES whatsapp_accounts(id),

  chat_jid TEXT NOT NULL,
  jid_kind TEXT NOT NULL
    CHECK (jid_kind IN ('individual', 'lid', 'group', 'broadcast', 'newsletter', 'unknown')),
  chat_type TEXT NOT NULL
    CHECK (chat_type IN ('individual', 'group', 'broadcast', 'status', 'newsletter', 'other')),

  contact_id UUID REFERENCES whatsapp_contacts(id),
  group_id UUID REFERENCES whatsapp_groups(id),

  name TEXT,
  phone_number TEXT,

  is_group BOOLEAN NOT NULL DEFAULT false,
  is_archived BOOLEAN,
  is_muted BOOLEAN,
  is_pinned BOOLEAN,
  is_read_only BOOLEAN,

  unread_count INTEGER NOT NULL DEFAULT 0,
  read_count INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,

  -- No FK yet: whatsapp_messages doesn't exist until the next migration.
  -- 010_add_cross_table_foreign_keys.sql attaches the real constraint once it does.
  last_message_id UUID,
  last_message_at TIMESTAMPTZ,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_type TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (source_type IN ('whatsapp', 'manual', 'google', 'crm', 'system')),

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE UNIQUE INDEX whatsapp_chats_identity_idx
  ON whatsapp_chats (business_id, whatsapp_account_id, chat_jid)
  WHERE deleted_at IS NULL;

CREATE INDEX whatsapp_chats_last_message_at_idx
  ON whatsapp_chats (whatsapp_account_id, last_message_at DESC NULLS LAST);
