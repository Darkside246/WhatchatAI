-- A real, self-serve plan-tier upgrade checkout, mirroring
-- ai_token_topup_purchases/ai_memory_topup_purchases (migrations 980/986)
-- closely - same checkout-then-verify shape, same provider constraint,
-- same RLS. On verification, planUpgradeService.ts actually changes the
-- business's subscriptions.plan_id (see subscriptionRepository.ts's
-- changePlan), unlike the top-ups which only ever add capacity.
--
-- prorated_amount_minor and full_amount_minor are both stored (not just
-- the one actually charged) so the real proration math applied at
-- checkout time stays auditable after the fact, even once the business's
-- billing period has moved on.
CREATE TABLE plan_upgrade_purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  from_plan_id UUID NOT NULL REFERENCES plans(id),
  to_plan_id UUID NOT NULL REFERENCES plans(id),
  provider TEXT NOT NULL CHECK (provider IN ('BIMPAY', 'PAYPAL', 'WIPAY', 'BANK_TRANSFER', 'OTHER')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED')),
  checkout_reference TEXT NOT NULL UNIQUE,
  was_prorated BOOLEAN NOT NULL,
  full_amount_minor BIGINT NOT NULL CHECK (full_amount_minor > 0),
  amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
  currency TEXT NOT NULL DEFAULT 'BBD',
  provider_event_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  verified_at TIMESTAMPTZ
);

CREATE INDEX idx_plan_upgrade_purchases_business ON plan_upgrade_purchases (business_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON plan_upgrade_purchases TO whatchatai_tenant;
ALTER TABLE plan_upgrade_purchases ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plan_upgrade_purchases USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- One new notification type (PLAN_UPGRADED), same convention as
-- migrations 980/986's own additions - this constraint is the single
-- source of truth, rewritten wholesale, copied exactly from
-- NotificationType's own union plus this one addition.
ALTER TABLE notifications DROP CONSTRAINT notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check CHECK (type IN (
  'HUMAN_HANDOFF', 'NEW_MESSAGE', 'NEW_LEAD', 'MENTION', 'ASSIGNMENT',
  'AI_FAILURE', 'AUTOMATION_FAILURE', 'SYNC_FAILURE', 'PAYMENT_ISSUE', 'CALL',
  'STATUS', 'SLA_BREACH', 'SECURITY_ALERT', 'CAMPAIGN_FAILURE', 'SYSTEM',
  'AI_BUDGET_EXCEEDED', 'AI_TOKENS_ADDED', 'AI_MEMORY_ADDED', 'PLAN_UPGRADED'
));
