-- A real, self-serve top-up purchase for AI customer-memory capacity,
-- mirroring ai_token_topup_purchases (migration 980) closely - same
-- checkout-then-verify shape, same provider constraint, same RLS. The one
-- real difference: memory capacity is a standing cap, not a monthly
-- consumable that resets - a verified memory purchase raises the
-- business's effective max_customer_memory_profiles limit permanently
-- (see aiMemoryTopupRepository.ts's getVerifiedProfilesForBusiness, which
-- deliberately sums ALL verified purchases, not just this calendar
-- month's, unlike its token-topup counterpart).
CREATE TABLE ai_memory_topup_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('BIMPAY', 'PAYPAL', 'WIPAY', 'BANK_TRANSFER', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  checkout_reference TEXT NOT NULL UNIQUE,
  profiles_purchased BIGINT NOT NULL CHECK (profiles_purchased > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'BBD',
  provider_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX idx_ai_memory_topup_purchases_business_verified ON ai_memory_topup_purchases (business_id) WHERE status = 'VERIFIED';

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_memory_topup_purchases TO whatchatai_tenant;
ALTER TABLE ai_memory_topup_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_memory_topup_purchases USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- One new notification type (AI_MEMORY_ADDED), same convention as
-- migration 980's AI_TOKENS_ADDED - this constraint is the single source
-- of truth, rewritten wholesale, copied exactly from NotificationType's
-- own union plus this one addition.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'HUMAN_HANDOFF', 'NEW_MESSAGE', 'NEW_LEAD', 'MENTION', 'ASSIGNMENT',
  'AI_FAILURE', 'AUTOMATION_FAILURE', 'SYNC_FAILURE', 'PAYMENT_ISSUE', 'CALL',
  'STATUS', 'SLA_BREACH', 'SECURITY_ALERT', 'CAMPAIGN_FAILURE', 'SYSTEM',
  'AI_BUDGET_EXCEEDED', 'AI_TOKENS_ADDED', 'AI_MEMORY_ADDED'
));
