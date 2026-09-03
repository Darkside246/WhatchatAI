-- Section 06 (Invisible Conversational Funnel) and Section 10 (Customer
-- Readiness) of the AURA master directive: conversation_states (migration
-- 025-era, extended for goal/facts/questions since) gains two more model-
-- writable fields, following the exact same pattern as the existing ones -
-- nullable, optimistic-concurrency-patched, never customer-visible. Both
-- are a current-state snapshot (the model's latest read of "where is this
-- conversation right now"), not an accumulating history like confirmed_facts,
-- so they are overwritten on each write rather than merged.
ALTER TABLE conversation_states ADD COLUMN funnel_stage TEXT CHECK (funnel_stage IN (
  'NEW', 'CONVERSING', 'INTENT_IDENTIFIED', 'NEED_IDENTIFIED', 'QUALIFIED',
  'SOLUTION_MATCHED', 'INTEREST_CONFIRMED', 'APPOINTMENT_OFFERED',
  'APPOINTMENT_SELECTED', 'BOOKED', 'FOLLOW_UP', 'CUSTOMER'
));
ALTER TABLE conversation_states ADD COLUMN customer_readiness TEXT CHECK (customer_readiness IN (
  'NOT_READY', 'BROWSING', 'NEEDS_INFORMATION', 'COMPARING', 'INTERESTED',
  'HIGHLY_INTERESTED', 'READY_TO_ACT', 'URGENT'
));
