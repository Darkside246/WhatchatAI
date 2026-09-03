-- Real 5-level autonomy ladder, replacing the boolean added in migration
-- 955. That migration's own comment explicitly rejected a "graduated 0-5
-- ladder" at the time - there was only one gateable action (SEND-tier
-- meeting booking) and no second axis to make 5 levels genuinely differ.
-- Two more real primitives exist now to build the ladder on: the
-- business-wide "Stop All Agents" READ-only tool filter (ai_actions_paused,
-- migration 952, previously business-wide only) and notifyBusiness
-- (previously never called from the AI reply path). See aiReplyService.ts
-- and agentGuard.ts for how each level actually differs:
--   1 - read-only: every non-READ tool is withheld entirely, enforced in
--       agentGuard.ts's guardToolInvocation (the one authoritative gate).
--   2 - manual: SEND-tier actions (meeting booking) go to the real
--       approval queue instead of executing.
--   3 - balanced (default): SEND-tier actions execute immediately - the
--       exact behavior every pre-955 and requires_approval_for_actions=false
--       agent already had.
--   4 - trusted: same execution as 3, plus a real notifyBusiness() call
--       after a successful SEND-tier action so a teammate sees it happened.
--   5 - fully autonomous: same execution as 3, no extra notification.
ALTER TABLE ai_agents ADD COLUMN autonomy_level SMALLINT NOT NULL DEFAULT 3 CHECK (autonomy_level BETWEEN 1 AND 5);

UPDATE ai_agents SET autonomy_level = CASE WHEN requires_approval_for_actions THEN 2 ELSE 3 END;

ALTER TABLE ai_agents DROP COLUMN requires_approval_for_actions;
