-- Real "forgotten commitment" detection (AURA Master Engineering Prompt
-- section 32: "analyzing conversational exhaust to identify promised
-- actions that lack corresponding calendar or task entries"). Every real
-- AI reply that makes a detectable follow-up promise (see
-- commitmentDetector.ts) gets one row here. "Open" is computed at read
-- time (see AiCommitmentRepository.listOpen) by checking whether a real,
-- later outbound message exists in the same chat - no background sweep
-- or resolved_at column to keep in sync, since this table is read
-- occasionally (a dashboard widget), not in any hot path.
CREATE TABLE ai_commitments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  chat_id           UUID NOT NULL REFERENCES whatsapp_chats(id) ON DELETE CASCADE,
  commitment_text   TEXT NOT NULL,
  detected_phrase   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_ai_commitments_business_time ON ai_commitments (business_id, created_at DESC);
