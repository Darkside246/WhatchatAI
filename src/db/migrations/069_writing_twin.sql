-- Phase W3: Personal AI Writing Twin.
--
-- Implements exactly the design approved across W1-A (attribution audit),
-- W1-B (architecture proposal), W2-A (schema design), and W2-B
-- (implementation proposal) - no table or constraint here was invented in
-- this migration; every one traces to a specific, already-reviewed design
-- decision referenced in the comments below.
--
-- GOVERNING SAFETY DECISIONS enforced by this schema, not merely by
-- application code:
--
-- 1. Every table's ownership is a composite FK to business_memberships
--    (business_id, user_id), not two independent FKs to businesses/users.
--    This proves the pairing is a REAL membership, not just two
--    independently-valid ids (W2-B S1/S2) - and ON DELETE CASCADE means
--    removing a member automatically, atomically deletes every one of
--    that user's Writing Twin rows for that business, with no
--    application code required to remember to do it.
--
-- 2. Tier B provenance (source_provenance/provenance) is CHECK-restricted
--    to exactly the three learning-eligible states
--    ('human_authored', 'ai_generated_then_edited', 'explicitly_approved').
--    The two disallowed states from W1-B's five-state model
--    ('ai_generated_unchanged', 'unknown_or_ambiguous') are not merely
--    discouraged - they are impossible to insert.
--
-- 3. Every Tier A signal is an individually CHECK-constrained bounded
--    enum, or a bounded/length-capped array - never free-form text or
--    unconstrained JSON (W2-A S11, W2-B S1's schema-bound requirement).
--
-- 4. writing_twin_profiles is versioned and immutable per version; a
--    partial unique index guarantees AT MOST ONE (never "exactly one" -
--    W2-B's own clarification) is_current=true row per
--    (business_id, user_id, channel_scope).
--
-- 5. writing_twin_profile_derivations is a real FK-enforced join between
--    a profile version and the Tier B examples it was computed from -
--    chosen over a plain UUID array specifically so a deleted example's
--    CASCADE makes an affected profile version's staleness a detectable,
--    queryable fact, not an assumption (W2-B S3).
--
-- 6. writing_twin_raw_events.expires_at is NOT NULL, computed once at
--    insert time in application code (never recomputed) - Tier C's
--    bounded-retention design exists specifically so this table can
--    never become an unlimited permanent archive of everything a user
--    has ever written.

CREATE TABLE writing_twin_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  user_id UUID NOT NULL,

  learning_enabled BOOLEAN NOT NULL DEFAULT false,
  historical_backfill_requested_at TIMESTAMPTZ,
  historical_backfill_completed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (business_id, user_id) REFERENCES business_memberships (business_id, user_id) ON DELETE CASCADE,
  UNIQUE (business_id, user_id)
);

CREATE INDEX idx_writing_twin_settings_user ON writing_twin_settings (user_id);

-- CHECK constraints cannot contain a bare subquery, so per-element array
-- length bounds (below) go through this small immutable helper instead -
-- a function body may use a subquery even though a CHECK expression
-- itself may not. Returns NULL (never FALSE) for an empty/null array, so
-- the CHECK that calls it passes normally in that case.
CREATE FUNCTION writing_twin_max_element_length(elements TEXT[]) RETURNS INTEGER
  LANGUAGE sql IMMUTABLE AS $$
    SELECT max(length(v)) FROM unnest(elements) AS v
  $$;

CREATE TABLE writing_twin_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  user_id UUID NOT NULL,
  channel_scope TEXT NOT NULL CHECK (channel_scope IN ('global', 'email', 'whatsapp')),
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  is_current BOOLEAN NOT NULL DEFAULT true,

  -- Every signal below is a bounded enum or a bounded/length-capped
  -- array - the schema itself is the allow-listed vocabulary. NULL means
  -- "not yet enough signal to determine this," never a fabricated
  -- default bucket.
  preferred_tone TEXT CHECK (preferred_tone IN ('concise', 'balanced', 'detailed')),
  formality TEXT CHECK (formality IN ('casual', 'neutral', 'formal')),
  greeting_style TEXT CHECK (greeting_style IN ('none', 'minimal', 'warm')),
  sign_off_style TEXT CHECK (sign_off_style IN ('none', 'minimal', 'warm')),
  avg_sentence_length_bucket TEXT CHECK (avg_sentence_length_bucket IN ('short', 'medium', 'long')),
  punctuation_emphasis TEXT CHECK (punctuation_emphasis IN ('low', 'moderate', 'high')),
  emoji_frequency TEXT CHECK (emoji_frequency IN ('none', 'low', 'moderate', 'high')),
  directness TEXT CHECK (directness IN ('direct', 'balanced', 'hedged')),
  question_pattern TEXT CHECK (question_pattern IN ('rare', 'occasional', 'frequent')),
  common_phrases TEXT[] NOT NULL DEFAULT '{}',
  common_sign_offs TEXT[] NOT NULL DEFAULT '{}',

  example_count INTEGER NOT NULL DEFAULT 0,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  superseded_at TIMESTAMPTZ,

  FOREIGN KEY (business_id, user_id) REFERENCES business_memberships (business_id, user_id) ON DELETE CASCADE,
  UNIQUE (business_id, user_id, channel_scope, version_number),

  CONSTRAINT writing_twin_profiles_common_phrases_bound
    CHECK (array_length(common_phrases, 1) IS NULL OR array_length(common_phrases, 1) <= 8),
  CONSTRAINT writing_twin_profiles_common_signoffs_bound
    CHECK (array_length(common_sign_offs, 1) IS NULL OR array_length(common_sign_offs, 1) <= 5),
  CONSTRAINT writing_twin_profiles_phrase_length_check
    CHECK (writing_twin_max_element_length(common_phrases) <= 80),
  CONSTRAINT writing_twin_profiles_signoff_length_check
    CHECK (writing_twin_max_element_length(common_sign_offs) <= 40)
);

CREATE INDEX idx_writing_twin_profiles_user ON writing_twin_profiles (business_id, user_id, channel_scope);

-- Structurally enforces "at most one current version" per channel - a
-- partial unique index, not application discipline. See the module
-- comment: this is deliberately "at most one," never "exactly one" -
-- zero is the honest, legitimate state before any evidence exists.
CREATE UNIQUE INDEX idx_writing_twin_profiles_current
  ON writing_twin_profiles (business_id, user_id, channel_scope)
  WHERE is_current;

CREATE TABLE writing_twin_style_examples (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  user_id UUID NOT NULL,
  channel_scope TEXT NOT NULL CHECK (channel_scope IN ('global', 'email', 'whatsapp')),

  -- Deliberately excludes 'ai_generated_unchanged' and
  -- 'unknown_or_ambiguous' from the CHECK itself - a row with either
  -- value can never be inserted, the strongest possible enforcement of
  -- W1-B's five-state provenance model.
  source_provenance TEXT NOT NULL CHECK (source_provenance IN
    ('human_authored', 'ai_generated_then_edited', 'explicitly_approved')),

  -- Encrypted at rest via EncryptionService.encryptField/serialize
  -- (tenantId = business_id), the same pattern whatsapp_messages.
  -- text_content already uses successfully - safe here because, unlike
  -- business_document_chunks.text, this column is never content-searched.
  example_text TEXT NOT NULL CHECK (length(example_text) <= 8000),
  -- (8000 chars bounds the serialized EncryptedEnvelope JSON, which is
  -- larger than the 2000-char plaintext bound W2-B specified - the
  -- envelope's base64 ciphertext/iv/authTag/keyId overhead is real and
  -- must fit within this column's own bound.)

  source_table TEXT NOT NULL CHECK (source_table IN ('email_messages', 'whatsapp_outbound_messages')),
  source_row_id UUID NOT NULL,

  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (business_id, user_id) REFERENCES business_memberships (business_id, user_id) ON DELETE CASCADE,
  UNIQUE (business_id, user_id, channel_scope, source_table, source_row_id)
);

CREATE INDEX idx_writing_twin_style_examples_user
  ON writing_twin_style_examples (business_id, user_id, channel_scope, added_at DESC);

CREATE TABLE writing_twin_raw_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL,
  user_id UUID NOT NULL,
  -- No 'global' here - a raw event is always channel-specific at capture
  -- time; 'global' only ever exists as a derived Tier A aggregation.
  channel_scope TEXT NOT NULL CHECK (channel_scope IN ('email', 'whatsapp')),

  provenance TEXT NOT NULL CHECK (provenance IN
    ('human_authored', 'ai_generated_then_edited', 'explicitly_approved')),

  source_table TEXT NOT NULL CHECK (source_table IN ('email_messages', 'whatsapp_outbound_messages')),
  source_row_id UUID NOT NULL,

  -- Both encrypted at rest, same pattern/reasoning as example_text above.
  ai_baseline_text TEXT CHECK (ai_baseline_text IS NULL OR length(ai_baseline_text) <= 20000),
  final_text TEXT NOT NULL CHECK (length(final_text) <= 20000),

  processed_at TIMESTAMPTZ,
  -- Computed once at insert time by the application (never recomputed or
  -- extended later) - see the module comment's point 6.
  expires_at TIMESTAMPTZ NOT NULL,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  FOREIGN KEY (business_id, user_id) REFERENCES business_memberships (business_id, user_id) ON DELETE CASCADE,

  -- A correction record (ai_generated_then_edited) must carry a baseline
  -- to diff against; any other provenance must not carry one it would
  -- have no honest source for.
  CONSTRAINT writing_twin_raw_events_baseline_matches_provenance CHECK (
    (provenance = 'ai_generated_then_edited' AND ai_baseline_text IS NOT NULL)
    OR (provenance != 'ai_generated_then_edited' AND ai_baseline_text IS NULL)
  )
);

CREATE INDEX idx_writing_twin_raw_events_user ON writing_twin_raw_events (business_id, user_id, channel_scope);
-- The index the expiry sweep actually scans - unprocessed-or-not, purely
-- by time, matching the existing pending/stale-job partial-index
-- convention (whatsapp_outbound_messages_pending_idx and equivalents).
CREATE INDEX idx_writing_twin_raw_events_expiry ON writing_twin_raw_events (expires_at);

-- The FK-enforced provenance link (W2-B S3): a real join table, chosen
-- over a plain UUID array specifically because a plain array cannot be
-- validated by a foreign key. When a style example is deleted, its
-- derivation rows are atomically removed by CASCADE - the profile
-- version's row is untouched, but a live derivation-row count below its
-- recorded example_count makes staleness a detectable fact, not an
-- assumption.
CREATE TABLE writing_twin_profile_derivations (
  profile_version_id UUID NOT NULL REFERENCES writing_twin_profiles (id) ON DELETE CASCADE,
  style_example_id UUID NOT NULL REFERENCES writing_twin_style_examples (id) ON DELETE CASCADE,
  PRIMARY KEY (profile_version_id, style_example_id)
);

ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_event_type_check;
ALTER TABLE security_audit_logs ADD CONSTRAINT security_audit_logs_event_type_check CHECK (event_type IN (
  'sentinel_heuristic_block', 'sentinel_ai_block', 'sentinel_ai_unavailable', 'sentinel_pass',
  'lock_setup', 'lock_unlock_success', 'lock_unlock_failure', 'lock_throttled', 'lock_revoked',
  'campaign_created', 'campaign_approved', 'campaign_sent', 'campaign_cancelled',
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
  'writing_twin_example_removed'
));
