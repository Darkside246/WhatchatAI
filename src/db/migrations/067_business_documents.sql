-- Phase B, D1: the secure ownership/persistence foundation for business
-- documents, per docs/PHASE_B_CONSOLIDATED_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md
-- (D1 scope only - no parsing, no chunking, no AI retrieval, no cloud
-- storage connector, no send capability). Table shapes carried forward
-- from that document's approved design (itself carried from Phase 2C's
-- proposal), with every column D1 cannot yet populate given the
-- narrowest CHECK constraint D1 can actually produce - the same
-- "narrow now, widen later via ALTER" discipline already used
-- repeatedly in this codebase for security_audit_logs.event_type and
-- email_messages.status. Columns whose entire purpose is the explicitly
-- deferred, not-yet-authorised D5 (cloud storage connectors) - e.g. an
-- external provider's own file/revision id - are not created here at
-- all; D5 adds them if and when it is separately authorised.
--
-- business_id is present on every table and is the only tenant
-- boundary a repository query ever needs - never a bare findById.

CREATE TABLE business_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  filename TEXT NOT NULL,
  -- Added via ALTER below once business_document_versions exists - a
  -- forward reference within this same migration/transaction, matching
  -- the ordering Phase 2C's proposal already called out for exactly
  -- this reason.
  current_version_id UUID NULL,
  -- D1 only ever produces 'uploaded'. D2 widens this via
  -- ALTER TABLE ... DROP/ADD CONSTRAINT once real parsing exists to
  -- advance a document toward 'processing'/'ready'/'failed'/'stale'.
  status TEXT NOT NULL DEFAULT 'uploaded' CHECK (status IN ('uploaded')),
  -- Four independent capability flags, not a single enum - a document
  -- can be retrievable-but-not-sendable, customer-visible-but-not-
  -- AI-anything, etc. Every new document defaults to all four false:
  -- fails closed, nothing is AI-retrievable/AI-sendable/customer-visible
  -- until a human explicitly opts it in (Phase B hard invariant #8).
  ai_retrievable BOOLEAN NOT NULL DEFAULT false,
  ai_sendable BOOLEAN NOT NULL DEFAULT false,
  customer_visible BOOLEAN NOT NULL DEFAULT false,
  human_only BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Soft delete: a deleted document must still be distinguishable for
  -- audit purposes, but every scoped read excludes it.
  deleted_at TIMESTAMPTZ NULL,
  CONSTRAINT business_documents_human_only_excludes_ai
    CHECK (NOT (human_only AND (ai_retrievable OR ai_sendable))),
  CONSTRAINT business_documents_sendable_implies_retrievable
    CHECK (NOT (ai_sendable AND NOT ai_retrievable))
);

CREATE INDEX idx_business_documents_business ON business_documents (business_id);

CREATE TABLE business_document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Denormalized from the parent document, set once at insert from the
  -- same authenticated context that creates the row, never updated
  -- independently - the same rationale already established for
  -- whatsapp_media.business_id: it turns every scoped query into a
  -- single "WHERE id = $1 AND business_id = $2", the shape hardest to
  -- get wrong under time pressure, instead of requiring every future
  -- query author to remember to join through document_id correctly.
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  document_id UUID NOT NULL REFERENCES business_documents(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  -- SHA-256 of the raw uploaded bytes - same field name/shape already
  -- used by whatsapp_media.sha256.
  checksum TEXT NOT NULL,
  -- SHA-256 of the *extracted plaintext*, set once D2's parser
  -- succeeds. Always NULL in D1 - no parser exists yet.
  content_hash TEXT NULL,
  -- Raw, sender/uploader-declared MIME, stored verbatim - never mutated.
  mime_type TEXT NOT NULL,
  -- Normalized document-family classification (pdf/docx/text/csv) -
  -- every later decision reads this, never the raw mime_type. See
  -- src/domain/documents/documentMime.ts.
  mime_family TEXT NOT NULL,
  file_size BIGINT NOT NULL,
  -- Reuses the exact existing pattern in localEncryptedMediaStorage.ts
  -- (buildStorageReference(businessId, sha256) -> business-scoped path,
  -- EncryptionService.encryptBuffer at rest) - no new storage primitive.
  -- The ORIGINAL FILE is encrypted at rest via this reference.
  storage_reference TEXT NOT NULL,
  -- D1 never advances these past their defaults - no parser/chunker/
  -- indexer exists yet. D2/D3 each widen exactly the constraint they
  -- need via ALTER, when that stage actually exists to produce the
  -- other values.
  parser_status TEXT NOT NULL DEFAULT 'pending' CHECK (parser_status IN ('pending')),
  extraction_status TEXT NOT NULL DEFAULT 'pending' CHECK (extraction_status IN ('pending')),
  indexing_status TEXT NOT NULL DEFAULT 'pending' CHECK (indexing_status IN ('pending')),
  -- Phase B explicitly recommends not building embeddings - this
  -- reflects that decision as the real, permanent default, not a
  -- staging value awaiting a future step that will actually run.
  embedding_status TEXT NOT NULL DEFAULT 'not_applicable' CHECK (embedding_status IN ('not_applicable')),
  -- D1 only ever writes 'upload' - no cloud connector exists (D5 is
  -- explicitly deferred, not authorised this round).
  source_provider TEXT NOT NULL DEFAULT 'upload' CHECK (source_provider IN ('upload')),
  -- Honest, human-readable, never a raw stack trace with paths/secrets.
  -- Always NULL in D1 - nothing in this phase's own upload path can
  -- leave a row in a failed state after it is inserted (validation
  -- happens before the row is ever created).
  failure_reason TEXT NULL,
  -- Versions are immutable once created - no updated_at.
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT business_document_versions_unique_number UNIQUE (document_id, version_number)
);

CREATE INDEX idx_business_document_versions_business ON business_document_versions (business_id);

ALTER TABLE business_documents
  ADD CONSTRAINT business_documents_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES business_document_versions(id);

-- Same generic plan_entitlements mechanism knowledge_base_documents
-- already uses (migration 055) - no new entitlement machinery, just a
-- new key. Same tier shape (starter/growth/business/enterprise), same
-- reasoning: a company document library is comparable usage to the
-- existing knowledge base.
INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
SELECT id, 'max_business_documents', 10, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'max_business_documents', 50, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'max_business_documents', 200, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'max_business_documents', NULL, true FROM plans WHERE plan_key = 'enterprise';

-- Extends the existing security_audit_logs event_type CHECK constraint
-- with the three D1-relevant events, via the same DROP/ADD pattern
-- already used 9 times in this codebase (041, 042, 044, 045, 047, 052,
-- 053, 056, 058) - not a new, parallel audit table.
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
  'business_document_uploaded', 'business_document_upload_blocked', 'business_document_deleted'
));
