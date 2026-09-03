-- Sections 14-24 (Identity & Name Discovery Engine) of the AURA master
-- directive - two more real, model-writable/system-writable fields on
-- conversation_states, same pattern as funnel_stage/customer_readiness
-- (migration 963): current-state snapshots, not accumulating history.
--   preferred_name    - Tier 2 evidence (Section 15): what the customer
--                       explicitly said to call them, set via the existing
--                       update_conversation_memory tool. Never assumed
--                       from a WhatsApp display name.
--   last_name_used_at - Section 19 (Name Repetition Protection): set by
--                       the system itself (never the model) after
--                       deterministically checking whether a just-sent
--                       reply actually used the resolved name - the
--                       cooldown this drives is about what really went
--                       out, not what the model claims it did.
ALTER TABLE conversation_states ADD COLUMN preferred_name TEXT;
ALTER TABLE conversation_states ADD COLUMN last_name_used_at TIMESTAMPTZ;
