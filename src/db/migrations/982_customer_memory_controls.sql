-- AI Agents Page Consolidation: a real business-wide on/off switch for
-- cross-conversation customer memory (customer_memory table, Section 20),
-- same shape as migration 952's ai_actions_paused - a kill switch that
-- still lets replies through, it just stops persisting memory.
ALTER TABLE businesses ADD COLUMN customer_memory_enabled BOOLEAN NOT NULL DEFAULT true;

-- Backs the new generic (15-minute rate-limited) AI test-connection route -
-- a normal business member's own last test, never the developer-only
-- detailed Gemini test.
ALTER TABLE businesses ADD COLUMN ai_connection_tested_at TIMESTAMPTZ;

-- New plan_entitlements key: max_customer_memory_profiles. No schema
-- change needed - plan_entitlements is already a generic
-- (plan_id, entitlement_key, limit_value, is_enabled) table with no CHECK
-- constraint on allowed keys (confirmed by inspection).
--
-- Formula (stated assumption, not measured from real usage data yet -
-- same honesty as migration 980's AI Token Top-Up pricing comment,
-- revisit once real data exists): a customer_memory row is only created
-- when the AI confirms a genuinely memorable fact from a *returning*
-- customer (Section 20), not every contact. Using a small-business
-- estimate of ~300 real conversations/month per connected WhatsApp
-- number, of which ~15% result in a memorable confirmed fact
-- (conservative - only recurring/high-intent customers volunteer durable
-- facts), and treating memory as cumulative over a realistic ~3-month
-- active-customer window before natural churn: realistic standing need
-- ~= 135 profiles per WhatsApp number. Scaled by each tier's own
-- max_whatsapp_accounts (1/3/10/unlimited), then deliberately set ~25-30%
-- under that estimate:
--   Starter  (1 WA account,  realistic ~135)   -> cap 100   (26% under)
--   Growth   (3 WA accounts, realistic ~405)   -> cap 300   (26% under)
--   Business (10 WA accounts, realistic ~1350) -> cap 1000  (26% under)
--   Enterprise -> unlimited (limit_value NULL, matching every other
--   entitlement's own documented meaning)
INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
SELECT id, 'max_customer_memory_profiles', 100, true FROM plans WHERE plan_key = 'starter'
UNION ALL
SELECT id, 'max_customer_memory_profiles', 300, true FROM plans WHERE plan_key = 'growth'
UNION ALL
SELECT id, 'max_customer_memory_profiles', 1000, true FROM plans WHERE plan_key = 'business'
UNION ALL
SELECT id, 'max_customer_memory_profiles', NULL, true FROM plans WHERE plan_key = 'enterprise'
ON CONFLICT (plan_id, entitlement_key) DO NOTHING;
