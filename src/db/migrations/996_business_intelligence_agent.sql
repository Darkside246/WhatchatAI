-- AURA Business Intelligence & End-of-Line Quality Agent - a second,
-- independent background agent (separate from Learn, no dependency on
-- it either direction). Fail-closed by default (bi_settings.enabled
-- starts false, matching writing_twin_settings/writing_twin_agent_access's
-- own established least-privilege posture) - nothing is analyzed until a
-- business owner explicitly turns it on.

CREATE TABLE bi_settings (
  business_id  UUID        PRIMARY KEY REFERENCES businesses (id) ON DELETE CASCADE,
  enabled      BOOLEAN     NOT NULL DEFAULT false,
  last_run_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON bi_settings TO whatchatai_tenant;
ALTER TABLE bi_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bi_settings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- The structured extraction unit - directive section 11, adapted. Never
-- stores raw source text, only structured classification + real counts:
-- data-minimization by construction (directive section 8), and it means
-- no separate retention sweep is needed for raw content that was never
-- persisted here in the first place.
CREATE TABLE bi_observations (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id            UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  source_type            TEXT        NOT NULL CHECK (source_type IN ('chat', 'invoice', 'document', 'review')),
  period_start           TIMESTAMPTZ NOT NULL,
  period_end             TIMESTAMPTZ NOT NULL,
  product                TEXT,
  category               TEXT,
  topic                  TEXT,
  subtopic               TEXT,
  sentiment              TEXT        CHECK (sentiment IN ('positive', 'neutral', 'negative', 'mixed', 'unclear')),
  sentiment_confidence   REAL        CHECK (sentiment_confidence IS NULL OR (sentiment_confidence >= 0 AND sentiment_confidence <= 1)),
  intent                 TEXT,
  intent_confidence      REAL        CHECK (intent_confidence IS NULL OR (intent_confidence >= 0 AND intent_confidence <= 1)),
  feedback_type          TEXT,
  complaint_category     TEXT,
  purchase_signal        TEXT,
  urgency                TEXT        CHECK (urgency IS NULL OR urgency IN ('low', 'medium', 'high')),
  evidence_count         INTEGER     NOT NULL DEFAULT 0,
  conversation_count     INTEGER     NOT NULL DEFAULT 0,
  extraction_confidence  REAL        CHECK (extraction_confidence IS NULL OR (extraction_confidence >= 0 AND extraction_confidence <= 1)),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bi_observations_business_period ON bi_observations (business_id, period_start, period_end);
CREATE INDEX idx_bi_observations_business_product ON bi_observations (business_id, product) WHERE product IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON bi_observations TO whatchatai_tenant;
ALTER TABLE bi_observations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bi_observations USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- The Trends-facing, end-of-line-approved output. Only status='approved'
-- rows are ever read by the Trends API - everything else (held/rejected)
-- stays internal, auditable via quality_flags, never reaching a business
-- user. A streamlined subset of directive section 25's full lifecycle -
-- documented here, not silently narrowed.
CREATE TABLE bi_insights (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  category                    TEXT        NOT NULL CHECK (category IN ('sentiment', 'product_performance', 'feedback', 'emerging', 'operations')),
  title                       TEXT        NOT NULL,
  body                        TEXT        NOT NULL,
  direction                   TEXT        CHECK (direction IS NULL OR direction IN ('increasing', 'decreasing', 'stable', 'emerging', 'declining', 'anomalous')),
  metric_change_pct           REAL,
  period_start                TIMESTAMPTZ NOT NULL,
  period_end                  TIMESTAMPTZ NOT NULL,
  evidence_observation_count  INTEGER     NOT NULL DEFAULT 0,
  evidence_conversation_count INTEGER     NOT NULL DEFAULT 0,
  confidence                  TEXT        NOT NULL CHECK (confidence IN ('insufficient_data', 'early_signal', 'moderate', 'high')),
  status                      TEXT        NOT NULL DEFAULT 'processing' CHECK (status IN ('processing', 'approved', 'rejected', 'held')),
  quality_flags               JSONB       NOT NULL DEFAULT '[]',
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at                 TIMESTAMPTZ
);

CREATE INDEX idx_bi_insights_business_status ON bi_insights (business_id, status);
CREATE INDEX idx_bi_insights_business_category ON bi_insights (business_id, category) WHERE status = 'approved';

GRANT SELECT, INSERT, UPDATE, DELETE ON bi_insights TO whatchatai_tenant;
ALTER TABLE bi_insights ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bi_insights USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- Directive section 26 - never the actual sensitive value, matching
-- security_audit_logs' own "never pass message text" convention.
CREATE TABLE bi_security_alerts (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  alert_type   TEXT        NOT NULL CHECK (alert_type IN ('pii_detected', 'secret_detected', 'prompt_injection_detected')),
  source_type  TEXT        NOT NULL CHECK (source_type IN ('chat', 'invoice', 'document', 'review', 'generated_insight')),
  source_id    UUID,
  redacted     BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_bi_security_alerts_business ON bi_security_alerts (business_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON bi_security_alerts TO whatchatai_tenant;
ALTER TABLE bi_security_alerts ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON bi_security_alerts USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- A new, currently-unpopulated data source (per the user's own scoping
-- answer): real schema now, so the BI pipeline already reads from it,
-- but the actual WhatsApp-follow-up collection flow that would populate
-- source='whatsapp_followup' is explicitly out of scope for this build -
-- this table needs no further schema work once that feature ships later.
CREATE TABLE customer_reviews (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  crm_contact_id  UUID        REFERENCES crm_contacts (id) ON DELETE SET NULL,
  source          TEXT        NOT NULL DEFAULT 'manual' CHECK (source IN ('whatsapp_followup', 'manual', 'other')),
  rating          SMALLINT    CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  review_text     TEXT,
  collected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_customer_reviews_business ON customer_reviews (business_id, collected_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON customer_reviews TO whatchatai_tenant;
ALTER TABLE customer_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON customer_reviews USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked', 'lock_pin_changed',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled', 'campaign_deleted',
  'funnel_created', 'funnel_activated', 'funnel_deactivated', 'funnel_enrolled', 'funnel_deleted',
  'team_created', 'chat_assigned',
  'member_created', 'member_role_changed',
  'agent_updated',
  'message_revoke_requested', 'campaign_recalled', 'status_revoke_requested',
  'email_drafted', 'email_approved', 'email_sent', 'email_cancelled', 'email_settings_updated',
  'email_test_sent', 'goose_settings_updated', 'goose_tested',
  'ai_tool_invoked', 'ai_tool_denied',
  'ai_prompt_optimization_imported', 'ai_prompt_optimization_approved', 'ai_prompt_optimization_rejected',
  'business_document_uploaded', 'business_document_upload_blocked', 'business_document_deleted',
  'business_document_parsed', 'business_document_parse_failed',
  'writing_twin_learning_enabled', 'writing_twin_learning_disabled',
  'writing_twin_backfill_requested', 'writing_twin_deleted', 'writing_twin_profile_reset',
  'writing_twin_example_removed',
  'writing_twin_share_enabled', 'writing_twin_share_disabled',
  'writing_twin_agent_access_changed', 'writing_twin_profile_computed', 'writing_twin_context_served',
  'contact_privacy_updated', 'crm_contact_memory_erased',
  'handover_auto_reverted',
  'account_deletion_requested', 'account_deletion_cancelled', 'phone_number_changed',
  'ai_output_leak_blocked', 'ai_output_leak_check_unavailable',
  'message_risk_flagged',
  'plan_updated', 'plan_entitlement_updated', 'vertical_assigned',
  'platform_setting_updated',
  'subscription_plan_manually_changed',
  'bi_settings_enabled', 'bi_settings_disabled',
  'bi_insight_approved', 'bi_insight_rejected', 'bi_insight_held',
  'bi_security_alert_detected'
));
