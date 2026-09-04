-- Section 34-40's deliberately-deferred budget-override flow: a real,
-- self-serve token top-up purchase for a business that has exhausted its
-- plan's monthly AI budget mid-month. Deliberately its own small table,
-- not bolted onto payment_attempts/product_account_subscriptions - those
-- are tightly coupled to activating a product-account subscription, a
-- different billing system than the plans/subscriptions tables
-- EntitlementService.canUseAiThisMonth() actually gates against. See
-- aiTokenTopupService.ts for the real, researched pricing this backs
-- (Gemini 3.5 Flash's actual per-token cost, a stated blended-cost
-- assumption, and the resulting ~55-58% margin).
CREATE TABLE ai_token_topup_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('BIMPAY', 'PAYPAL', 'WIPAY', 'BANK_TRANSFER', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  checkout_reference TEXT NOT NULL UNIQUE,
  tokens_purchased BIGINT NOT NULL CHECK (tokens_purchased > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'BBD',
  provider_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX idx_ai_token_topup_purchases_business_verified ON ai_token_topup_purchases (business_id, verified_at) WHERE status = 'VERIFIED';

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_token_topup_purchases TO whatchatai_tenant;
ALTER TABLE ai_token_topup_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_token_topup_purchases USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- Two new real notification types: AI_BUDGET_EXCEEDED (the upsell prompt,
-- distinct from the existing generic AI_FAILURE hand-off notification
-- that keeps firing unchanged) and AI_TOKENS_ADDED (purchase confirmed).
-- Per 927/940/962/971/974/977's established convention: this constraint
-- is the single source of truth, rewritten wholesale, copied exactly
-- from NotificationType's own union.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'HUMAN_HANDOFF', 'NEW_MESSAGE', 'NEW_LEAD', 'MENTION', 'ASSIGNMENT',
  'AI_FAILURE', 'AUTOMATION_FAILURE', 'SYNC_FAILURE', 'PAYMENT_ISSUE', 'CALL',
  'STATUS', 'SLA_BREACH', 'SECURITY_ALERT', 'CAMPAIGN_FAILURE', 'SYSTEM',
  'AI_BUDGET_EXCEEDED', 'AI_TOKENS_ADDED'
));
