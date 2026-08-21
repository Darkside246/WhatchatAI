-- Phase 6: a real knowledge base backend for AI agents, replacing the
-- honest "not implemented yet" stub in knowledgeBaseSearchService.ts.
-- Search is native Postgres full-text search (tsvector/GIN, ts_rank) -
-- deliberately not an embeddings/vector store: that would add a new
-- external API dependency (per-query embedding calls) and, most likely,
-- a new Postgres extension (pgvector) not present in this project's
-- postgres:16-alpine image, for a feature with no demonstrated need for
-- semantic (vs. lexical) matching yet. Full-text search is real, fast,
-- and uses only what this database already has.
CREATE TABLE knowledge_base_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  -- Title matches rank higher than body matches (setweight 'A' vs 'B').
  search_vector TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('english', coalesce(content, '')), 'B')
  ) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_knowledge_base_documents_business ON knowledge_base_documents (business_id);
CREATE INDEX idx_knowledge_base_documents_search ON knowledge_base_documents USING GIN (search_vector);

-- Same generic plan_entitlements mechanism campaigns/funnels already use -
-- no new entitlement machinery, just a new key.
INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
SELECT id, 'max_knowledge_base_documents', 10, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'max_knowledge_base_documents', 50, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'max_knowledge_base_documents', 200, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'max_knowledge_base_documents', NULL, true FROM plans WHERE plan_key = 'enterprise';
