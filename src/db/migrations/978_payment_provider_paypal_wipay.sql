-- Section 73-74: adds PayPal (real, built this pass) and WiPay (registry
-- slot only - see wipayProvider.ts's own doc comment for why its adapter
-- is a deliberate stub rather than a fabricated signature scheme) to the
-- set of payment providers a checkout/payment_attempt row can reference.
ALTER TABLE payment_attempts DROP CONSTRAINT payment_attempts_provider_check;
ALTER TABLE payment_attempts ADD CONSTRAINT payment_attempts_provider_check
  CHECK (provider IN ('BIMPAY', 'PAYPAL', 'WIPAY', 'BANK_TRANSFER', 'OTHER'));
