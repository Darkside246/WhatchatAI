-- Live Time and Timezone Intelligence: adds account-level manual clock
-- override on top of the existing business.timezone column (050). This is
-- deliberately scoped to the business (not per-message, not AI-settable) so
-- an operator can test/troubleshoot "what would the AI see right now"
-- without any inbound WhatsApp text ever being able to alter it - there is
-- no tool exposed to the AI that writes these columns, only the
-- authenticated Settings PATCH endpoint.
--
-- manual_override_target_utc / manual_override_set_at together let
-- TimeService rebase the override forward using real elapsed time since it
-- was saved, instead of freezing the clock at a stale value:
--   logical_now = manual_override_target_utc + (real_now - manual_override_set_at)
ALTER TABLE businesses
  ADD COLUMN time_source TEXT NOT NULL DEFAULT 'AUTOMATIC'
    CHECK (time_source IN ('AUTOMATIC', 'MANUAL')),
  ADD COLUMN manual_override_target_utc TIMESTAMPTZ NULL,
  ADD COLUMN manual_override_set_at TIMESTAMPTZ NULL;
