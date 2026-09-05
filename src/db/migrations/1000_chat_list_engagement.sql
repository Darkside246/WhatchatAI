-- Relationship-Confidence Engine follow-up: real engagement history, used
-- only as a tiebreaker (relationshipConfidenceService.ts) when keyword
-- matching alone produces a genuine tie - never a standalone signal, and
-- never a reason to guess where the existing keyword logic would
-- otherwise correctly stay null. A purpose-built table rather than mining
-- security_audit_logs' own JSONB (no index exists on
-- raw_metadata->>'chatId', and that table mixes every event type - a poor
-- query target for this).
CREATE TABLE chat_list_engagement (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  chat_id           UUID        NOT NULL REFERENCES whatsapp_chats (id) ON DELETE CASCADE,
  list_id           UUID        NOT NULL REFERENCES lists (id) ON DELETE CASCADE,
  engagement_count  INTEGER     NOT NULL DEFAULT 1,
  last_active_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (business_id, chat_id, list_id)
);

CREATE INDEX idx_chat_list_engagement_chat ON chat_list_engagement (business_id, chat_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON chat_list_engagement TO whatchatai_tenant;
ALTER TABLE chat_list_engagement ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON chat_list_engagement USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
