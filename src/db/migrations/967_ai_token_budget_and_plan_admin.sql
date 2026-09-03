-- Section 34-40 (Token economy / cost control): no per-business ceiling on
-- actual AI usage existed anywhere - max_ai_agents (025_seed_plans.sql)
-- caps how many agents a business can create, nothing ever capped what one
-- active agent could spend generating real replies. Uses the exact same
-- generic plan_entitlements mechanism every other limit already uses (see
-- 041/055/067's own comments to this effect) - no new schema.
--
-- These are real, developer-adjustable starting values, same as migration
-- 025's own "illustrative starting values... the business can change"
-- comment - the point of the new developer-only Plan Management UI
-- (planRepository.ts's updatePlan/upsertEntitlement) is that a developer
-- tunes these to real measured Gemini costs once known, not that these
-- numbers are final. Deliberately generous so no existing business is cut
-- off the moment this ships.
INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
SELECT id, 'max_ai_tokens_per_month', 500000, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'max_ai_tokens_per_month', 2000000, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'max_ai_tokens_per_month', 10000000, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'max_ai_tokens_per_month', NULL, true FROM plans WHERE plan_key = 'enterprise';
