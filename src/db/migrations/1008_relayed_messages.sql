-- "Take a message" board: when a customer asks the AI to pass something
-- along to someone else (the business owner, a named family member,
-- etc.) rather than something the AI can answer itself, this is where
-- that real request lands so a human doesn't have to notice it buried in
-- a WhatsApp thread. Dismissing an entry here never touches the real
-- WhatsApp conversation it came from - chat_id is a real FK, and the
-- underlying message stays exactly where it always was.
CREATE TABLE relayed_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  recipient_description TEXT NOT NULL,
  message_text TEXT NOT NULL,
  -- Already-disambiguated by the AI before it ever calls the tool (e.g.
  -- "8:00 PM today", "as soon as possible") - never a raw, still-ambiguous
  -- "8" the AI hasn't resolved. Null when no time was mentioned at all.
  when_text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at TIMESTAMPTZ
);

CREATE INDEX relayed_messages_business_open_idx ON relayed_messages (business_id, created_at DESC) WHERE dismissed_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON relayed_messages TO whatchatai_tenant;
ALTER TABLE relayed_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON relayed_messages USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
