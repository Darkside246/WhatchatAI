-- A per-agent override for the fixed message sent to a customer when the
-- Outbound Leak Guard blocks a reply (see incomingMessagesWorker.ts's
-- 'blocked_leak' branch) - null means "use the built-in default", same
-- shape as human_takeover_policy/greeting (a single nullable string, not
-- an array like protected_facts).
ALTER TABLE ai_agents
  ADD COLUMN blocked_reply_message TEXT;
