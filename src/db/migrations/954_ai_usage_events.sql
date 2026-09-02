-- Real per-call Gemini token usage (AURA Master Engineering Prompt's "AI
-- Cost Telemetry" - real, currently-missing observability, not present
-- anywhere in the codebase before this). Deliberately tracks token counts
-- only, never a fabricated dollar cost - this codebase does not have a
-- verified, current Gemini pricing table, and inventing one would violate
-- the project's own "never claim a number that isn't real" rule. A price-
-- per-token can be layered on top later once real pricing is confirmed.
CREATE TABLE ai_usage_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  agent_id              UUID REFERENCES ai_agents(id) ON DELETE SET NULL,
  chat_id               UUID REFERENCES whatsapp_chats(id) ON DELETE SET NULL,
  model                 TEXT NOT NULL,
  -- 'primary' | 'bare_retry' | 'tool_follow_up' | 'fallback' - which real
  -- call this was, since one reply can make more than one real API call
  -- (see aiReplyService.ts's generateAiReply/resolveToolCalls).
  call_kind             TEXT NOT NULL,
  prompt_tokens         INTEGER NOT NULL DEFAULT 0,
  candidates_tokens     INTEGER NOT NULL DEFAULT 0,
  total_tokens          INTEGER NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The real query shape this table exists to serve: "usage for business X
-- over the last N days," most-recent-first.
CREATE INDEX idx_ai_usage_events_business_time ON ai_usage_events (business_id, created_at DESC);
-- The developer-control-plane "top businesses by usage" query groups
-- across all tenants by time window - a plain time index without the
-- tenant column first serves that scan.
CREATE INDEX idx_ai_usage_events_time ON ai_usage_events (created_at DESC);
