-- What a wallet is allowed to RECEIVE, and what we have seen arrive.
--
-- The Central Bank's own figures for a basic (Tier 1) BiMPay wallet:
--
--   daily    BBD 750
--   monthly  BBD 2,500
--   annual   BBD 30,000
--
-- and those are limits on what can be RECEIVED, not sent. A restaurant on a
-- basic or custodian wallet passes BBD 750 on a quiet Friday lunch, at
-- which point payments stop arriving - mid-service, with food already
-- cooked. A business that linked an existing bank account instead has
-- whatever limit its own bank set, which may be none.
--
-- Nothing in the software can raise a limit. What it can do is know the
-- number, count what it has seen arrive, and say so before the orders
-- stop - which is the difference between an owner ringing their bank on
-- Monday and an owner losing a Friday night.

ALTER TABLE food_payment_methods
  /* Null means "not told" rather than "unlimited": a guess at somebody's
     bank limit is worse than no warning, because a warning that fires
     wrongly is one people learn to ignore. */
  ADD COLUMN IF NOT EXISTS daily_receive_limit_cents BIGINT,
  ADD COLUMN IF NOT EXISTS monthly_receive_limit_cents BIGINT;

GRANT SELECT, INSERT, UPDATE, DELETE ON food_payment_methods TO whatchatai_tenant;
