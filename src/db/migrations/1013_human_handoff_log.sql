-- The human-handoff log: an auditable record of every time a conversation
-- was taken away from the AI and handed to a person.
--
-- Why this exists as its own table rather than a dashboard query: the
-- "N messages needed a human" figure was only ever a live count of chats
-- currently sitting in HUMAN_TAKEOVER. It could not answer the questions an
-- operator actually has - which customer, what did they say, and what
-- triggered the takeover - and a chat resolved back to AI_ACTIVE vanished
-- from it entirely, taking its history with it. This keeps the real record.
--
-- SIZE: deliberately compact. The message body is NOT duplicated here -
-- message_id references the real whatsapp_messages row, and only a bounded
-- excerpt is stored so the log is readable on its own without a join and
-- without a second full copy of every customer message. reason is a short
-- enum-style token, not a sentence.
--
-- ENCRYPTION AT REST: customer_label, customer_phone and message_excerpt
-- are personal data, so they are stored exactly like whatsapp_messages'
-- own text_content - an AES-256-GCM envelope under this tenant's own
-- HKDF-derived key (see src/security/encryption). A dump of this table
-- without MASTER_ENCRYPTION_KEY reveals no customer identity or content.
-- reason/created_at stay plaintext: they carry no personal data and are
-- what the list is filtered and sorted by.
--
-- ENCRYPTION IN TRANSIT: served only over the Caddy HTTPS front door, same
-- as every other API route.
--
-- ACCESS: reading or clearing this log requires an unlocked app-lock
-- session (security_lock_credentials, Argon2id) on top of the ordinary
-- session auth - see securityLockService. RLS below is the database-level
-- backstop for tenant isolation, exactly as on every other tenant table.

CREATE TABLE IF NOT EXISTS human_handoff_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  chat_id uuid NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  -- Nullable: a takeover can be triggered by something other than a single
  -- message (an AI outage, an operator's own "ai off"), and the referenced
  -- message may later be deleted. The excerpt below survives either way.
  message_id uuid REFERENCES whatsapp_messages(id) ON DELETE SET NULL,

  -- Why the AI stopped. Matches whatsapp_chats.ai_mode_source tokens:
  -- no_agent, blocked_keyword, ai_unavailable, output_leak_blocked,
  -- ai_to_ai_loop_prevented, manual_reply_detected, operator_pause.
  reason text NOT NULL,
  -- The specific detail behind the reason when there is one - e.g. which
  -- blocked keyword matched. Encrypted: a keyword list is business data and
  -- the value can quote customer text.
  reason_detail text,

  -- Encrypted envelopes (see header).
  customer_label text,
  customer_phone text,
  message_excerpt text,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- The log is always read newest-first for one business, and cleared for one
-- business. One index serves both.
CREATE INDEX IF NOT EXISTS human_handoff_log_business_created_idx
  ON human_handoff_log (business_id, created_at DESC);

-- Lets the detail view for a single conversation stay cheap.
CREATE INDEX IF NOT EXISTS human_handoff_log_chat_idx
  ON human_handoff_log (chat_id, created_at DESC);

ALTER TABLE human_handoff_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON human_handoff_log;
CREATE POLICY tenant_isolation ON human_handoff_log
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
