-- Account (business) deletion, 30-day grace period. Columns live directly
-- on businesses rather than a separate tracking table - this mirrors this
-- exact table's own existing time_source/manual_override_* precedent
-- (businessRepository.ts's setManualTimeOverride/clearManualTimeOverride):
-- a single "is there a pending state change scheduled for the future"
-- concern with no need for historical rows.
ALTER TABLE businesses
  ADD COLUMN deletion_requested_at TIMESTAMPTZ,
  ADD COLUMN deletion_requested_by UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN scheduled_purge_at TIMESTAMPTZ;

CREATE INDEX businesses_scheduled_purge_idx ON businesses (scheduled_purge_at)
  WHERE deletion_requested_at IS NOT NULL;
