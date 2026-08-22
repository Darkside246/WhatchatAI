-- Phase B, D2: strict parser-isolation phase, per
-- docs/PHASE_B_CONSOLIDATED_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md and
-- the D2 directive. Ingestion -> extraction -> normalization -> chunking
-- -> full-text indexing only. No AI retrieval, no embeddings, no
-- Google Drive/Dropbox, no send capability - all still deferred.
--
-- Document ingestion and document AI retrieval remain two separate
-- security boundaries: nothing in this migration or the D2 worker it
-- backs ever sets ai_retrievable/ai_sendable/customer_visible/human_only
-- - those stay exactly as D1 left them (all false by default, human-set
-- only). A document reaching status='ready' here means "chunked and
-- indexed," never "available to the AI."

-- D1 narrowed these CHECK constraints to exactly what D1 could produce
-- (status='uploaded' only; parser/extraction/indexing_status='pending'
-- only), by design, with a documented plan to widen them here once D2
-- actually exists to produce the other values - the same DROP/ADD
-- pattern already used repeatedly in this codebase for
-- security_audit_logs.event_type.
ALTER TABLE business_documents DROP CONSTRAINT business_documents_status_check;
ALTER TABLE business_documents ADD CONSTRAINT business_documents_status_check
  CHECK (status IN ('uploaded', 'processing', 'ready', 'failed'));

ALTER TABLE business_document_versions DROP CONSTRAINT business_document_versions_parser_status_check;
ALTER TABLE business_document_versions ADD CONSTRAINT business_document_versions_parser_status_check
  CHECK (parser_status IN ('pending', 'parsing', 'parsed', 'failed', 'unsupported'));

ALTER TABLE business_document_versions DROP CONSTRAINT business_document_versions_extraction_status_check;
ALTER TABLE business_document_versions ADD CONSTRAINT business_document_versions_extraction_status_check
  CHECK (extraction_status IN ('pending', 'extracted', 'failed'));

ALTER TABLE business_document_versions DROP CONSTRAINT business_document_versions_indexing_status_check;
ALTER TABLE business_document_versions ADD CONSTRAINT business_document_versions_indexing_status_check
  CHECK (indexing_status IN ('pending', 'chunked', 'failed'));

-- embedding_status is deliberately NOT widened - D2 keeps embeddings
-- disabled per the approved architecture (§1.4: full-text search only,
-- unless a later phase demonstrates lexical search is insufficient).

CREATE TABLE business_document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalized, same rationale as every other table in this system:
  -- a single "WHERE id = $1 AND business_id = $2" is the boundary every
  -- repository method uses, never a join the caller has to remember.
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES business_documents(id) ON DELETE CASCADE,
  version_id UUID NOT NULL REFERENCES business_document_versions(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  -- Plaintext, not field-encrypted - the Phase B architecture's resolved
  -- decision (§1.3): the existing whatsapp_messages full-text index was
  -- found to be non-functional today specifically because its column
  -- holds an encrypted envelope, not plaintext, and Postgres tsvector
  -- cannot search ciphertext. Isolation for this table is the same
  -- business_id-scoped SQL boundary every other table here uses, matching
  -- knowledge_base_documents.content's own proven, unencrypted precedent.
  -- The original uploaded file remains encrypted at rest (unchanged,
  -- localEncryptedMediaStorage.ts) - this is the extracted, derived text.
  text TEXT NOT NULL,
  char_start INTEGER NOT NULL,
  char_end INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  search_vector TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_document_chunks_unique_sequence UNIQUE (version_id, sequence)
);

CREATE INDEX idx_business_document_chunks_business ON business_document_chunks (business_id);
CREATE INDEX idx_business_document_chunks_document ON business_document_chunks (document_id);
CREATE INDEX idx_business_document_chunks_search ON business_document_chunks USING GIN (search_vector);

-- Same DROP/ADD widening pattern as the D1 migration used, extending
-- the existing security_audit_logs table with the two D2 events - no
-- parallel audit system.
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
  'business_document_parsed', 'business_document_parse_failed'
));
