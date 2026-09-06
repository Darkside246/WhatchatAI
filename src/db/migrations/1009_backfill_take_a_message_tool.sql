-- Real, confirmed production gap: take_a_message (a WRITE-tier tool) was
-- added after many agents already had allowed_tools_enabled = true with a
-- curated list saved before this tool existed. Those agents can never
-- reach it without a manual edit - Gemini is never even offered the
-- function, so it narrates a fake "I've noted that down" instead of
-- actually calling it, and nothing ever lands on the Dashboard's message
-- board. This is a one-time, global backfill closing that gap for every
-- business - not a precedent for silently granting future WRITE/SEND
-- tools the same way; a newly-added tool should be surfaced for deliberate
-- review on the Agents page, not backfilled again like this.
--
-- Safe to grandfather in specifically here: any agent already trusted with
-- update_conversation_memory (an equally WRITE-tier, equally low-blast-
-- radius tool - both write only to this exact business/chat/customer, never
-- touch any other record or execute any real-world action) is no more
-- risky with take_a_message added alongside it.
UPDATE ai_agents
SET allowed_tools = allowed_tools || '["take_a_message"]'::jsonb
WHERE allowed_tools_enabled = true
  AND NOT (allowed_tools @> '["take_a_message"]'::jsonb);
