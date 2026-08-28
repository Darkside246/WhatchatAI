CREATE TABLE IF NOT EXISTS maintenance_triage_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  action_request_id UUID REFERENCES platform_action_requests(id) ON DELETE SET NULL,
  message_text TEXT NOT NULL,
  ai_category TEXT NOT NULL,
  ai_urgency TEXT NOT NULL,
  ai_confidence REAL NOT NULL,
  human_decision TEXT NOT NULL,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT maintenance_triage_feedback_human_decision_check CHECK (human_decision IN ('APPROVED', 'REJECTED'))
);

CREATE INDEX IF NOT EXISTS maintenance_triage_feedback_business_created
  ON maintenance_triage_feedback (business_id, created_at DESC);
