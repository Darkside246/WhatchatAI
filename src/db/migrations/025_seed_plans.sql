-- Real product configuration (pricing tiers and their entitlement limits), not
-- simulated customer/WhatsApp data. Tier names/prices/limits are illustrative
-- starting values the business can change; they are not fabricated usage.
INSERT INTO plans (plan_key, name, description, price_monthly_cents, price_yearly_cents, currency) VALUES
  ('starter', 'Starter', 'For solo operators getting started with WhatsApp business messaging.', 2900, 29000, 'USD'),
  ('growth', 'Growth', 'For growing teams that need more agents and automation.', 9900, 99000, 'USD'),
  ('business', 'Business', 'For established businesses running multiple WhatsApp lines.', 24900, 249000, 'USD'),
  ('enterprise', 'Enterprise', 'For large organizations with advanced entitlement needs.', 59900, 599000, 'USD');

INSERT INTO plan_entitlements (plan_id, entitlement_key, limit_value, is_enabled)
SELECT id, 'max_whatsapp_accounts', 1, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'max_ai_agents', 2, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'max_users', 2, true FROM plans WHERE plan_key = 'starter'
UNION ALL SELECT id, 'advanced_analytics', NULL, false FROM plans WHERE plan_key = 'starter'

UNION ALL SELECT id, 'max_whatsapp_accounts', 3, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'max_ai_agents', 5, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'max_users', 10, true FROM plans WHERE plan_key = 'growth'
UNION ALL SELECT id, 'advanced_analytics', NULL, true FROM plans WHERE plan_key = 'growth'

UNION ALL SELECT id, 'max_whatsapp_accounts', 10, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'max_ai_agents', 20, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'max_users', 50, true FROM plans WHERE plan_key = 'business'
UNION ALL SELECT id, 'advanced_analytics', NULL, true FROM plans WHERE plan_key = 'business'

UNION ALL SELECT id, 'max_whatsapp_accounts', NULL, true FROM plans WHERE plan_key = 'enterprise'
UNION ALL SELECT id, 'max_ai_agents', NULL, true FROM plans WHERE plan_key = 'enterprise'
UNION ALL SELECT id, 'max_users', NULL, true FROM plans WHERE plan_key = 'enterprise'
UNION ALL SELECT id, 'advanced_analytics', NULL, true FROM plans WHERE plan_key = 'enterprise';
