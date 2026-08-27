-- A trial may exist before the user completes account authentication. The
-- eventual product account remains the same tenant; only the owner binding
-- is completed during onboarding.
ALTER TABLE product_accounts ALTER COLUMN owner_user_id DROP NOT NULL;

ALTER TABLE product_accounts
  ADD CONSTRAINT product_accounts_owner_or_provisioning_check
  CHECK (status = 'PROVISIONING' OR owner_user_id IS NOT NULL);

ALTER TABLE trial_identities
  ADD CONSTRAINT trial_identity_user_unique UNIQUE (user_id);
