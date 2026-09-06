-- AURA AI Oversight & Reliability Agent - a broader, additional supervisory
-- layer alongside (not a replacement for) AI Governance v1's own narrow
-- 4-rule AI-agent-behavior sweep (governance_flags, migration 998/1001).
-- Same non-negotiable property as Governance v1: no HTTP path from an AI
-- agent's own tool-calling path into finding creation/review/status-change
-- exists anywhere - this table is written only by the scheduled
-- oversight-sweep job and read/updated only by requireDeveloper routes.

-- The core record - a materially richer shape than governance_flags
-- (multi-dimensional risk, a 5-value severity, a 7-state lifecycle,
-- structured evidence) because this system's scope is deliberately much
-- broader (application health, security/abuse, capacity, policy,
-- monitoring gaps), not because governance_flags was wrong for its own,
-- narrower job.
CREATE TABLE oversight_findings (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  category                 TEXT        NOT NULL CHECK (category IN ('application_health', 'security', 'abuse_spam', 'capacity', 'policy', 'monitoring_gap')),
  finding_type             TEXT        NOT NULL,
  title                    TEXT        NOT NULL,
  severity                 TEXT        NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low', 'informational')),
  confidence               REAL        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  impact                   SMALLINT    CHECK (impact IS NULL OR (impact >= 1 AND impact <= 5)),
  likelihood               SMALLINT    CHECK (likelihood IS NULL OR (likelihood >= 1 AND likelihood <= 5)),
  exposure                 SMALLINT    CHECK (exposure IS NULL OR (exposure >= 1 AND exposure <= 5)),
  urgency                  SMALLINT    CHECK (urgency IS NULL OR (urgency >= 1 AND urgency <= 5)),
  scope_description        TEXT,
  composite_risk_score     REAL,
  business_id              UUID        REFERENCES businesses (id) ON DELETE CASCADE,
  affected_component       TEXT,
  evidence                 JSONB       NOT NULL DEFAULT '{}',
  potential_causes         JSONB,
  root_cause               TEXT,
  recommended_investigation TEXT,
  recommended_remediation  TEXT,
  status                   TEXT        NOT NULL DEFAULT 'detected' CHECK (status IN ('detected', 'investigating', 'awaiting_human_review', 'approved', 'rejected', 'resolved', 'monitoring')),
  reviewed_by_user_id      UUID        REFERENCES users (id) ON DELETE SET NULL,
  window_start             TIMESTAMPTZ,
  window_end               TIMESTAMPTZ,
  dedup_key                TEXT        NOT NULL,
  first_detected_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_detected_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  occurrence_count         INTEGER     NOT NULL DEFAULT 1,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The sweep's own de-dup lookup - one open (non-terminal) finding per
-- dedup_key at a time, same shape as governance_flags' idx_governance_flags_dedup.
CREATE INDEX idx_oversight_findings_dedup ON oversight_findings (dedup_key) WHERE status NOT IN ('resolved', 'rejected');
CREATE INDEX idx_oversight_findings_open ON oversight_findings (status, last_detected_at DESC) WHERE status NOT IN ('resolved', 'rejected');

GRANT SELECT, INSERT, UPDATE, DELETE ON oversight_findings TO whatchatai_tenant;
ALTER TABLE oversight_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oversight_findings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- The real append-only audit trail (directive's own "audit records must be
-- append-oriented and protected against unauthorized modification" -
-- a single mutable status column on oversight_findings alone would not
-- satisfy this; every status transition is its own permanent row here).
-- Application code must never UPDATE or DELETE a row in this table.
CREATE TABLE oversight_finding_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id  UUID        NOT NULL REFERENCES oversight_findings (id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL CHECK (event_type IN ('raised', 'reoccurred', 'status_changed', 'note_added')),
  from_status TEXT,
  to_status   TEXT,
  user_id     UUID        REFERENCES users (id) ON DELETE SET NULL,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oversight_finding_events_finding ON oversight_finding_events (finding_id, created_at);

GRANT SELECT, INSERT ON oversight_finding_events TO whatchatai_tenant;
ALTER TABLE oversight_finding_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oversight_finding_events USING (
  finding_id IN (SELECT id FROM oversight_findings WHERE business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid)
);

-- The minimal real time-series for honest capacity forecasting (directive
-- section 27) - populated once per sweep tick for the handful of metrics
-- that have no existing historical persistence (queue backlog, connected
-- WhatsApp tenant count). Platform-wide only for v1 (business_id always
-- null today) - kept nullable so a future per-business metric needs no
-- schema change.
CREATE TABLE oversight_metric_samples (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  metric_key  TEXT        NOT NULL,
  business_id UUID        REFERENCES businesses (id) ON DELETE CASCADE,
  value       NUMERIC     NOT NULL,
  sampled_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_oversight_metric_samples_lookup ON oversight_metric_samples (metric_key, sampled_at DESC);

GRANT SELECT, INSERT, DELETE ON oversight_metric_samples TO whatchatai_tenant;
ALTER TABLE oversight_metric_samples ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oversight_metric_samples USING (
  business_id IS NULL OR business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid
);

-- 1004 was the last migration to touch this constraint - re-grepped
-- immediately before writing this one.
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
  'bi_security_alert_detected',
  'list_created', 'list_deleted',
  'list_agent_assigned', 'list_agent_unassigned',
  'list_membership_changed', 'list_active_list_set',
  'list_routed', 'list_scoped_memory_erased',
  'governance_flag_raised', 'governance_flag_reviewed', 'governance_flag_dismissed',
  'relationship_confidence_enabled', 'relationship_confidence_disabled',
  'relationship_suggestion_computed', 'relationship_suggestion_overridden',
  'developer_promoted', 'developer_demoted', 'developer_tier_changed',
  'business_tier_unrestricted_granted', 'business_tier_unrestricted_revoked',
  'auth_rate_limited', 'signup_recaptcha_failed',
  'oversight_finding_raised', 'oversight_finding_status_changed', 'oversight_monitoring_degraded'
));
