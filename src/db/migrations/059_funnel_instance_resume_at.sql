-- Real reconciliation for a funnel instance abandoned mid-WAIT: outbound
-- messages, sync jobs, and emails already have a stale-row sweep
-- (sweepStaleOutboundMessages/sweepStaleSyncJobs/sweepStaleEmails in
-- incomingMessagesWorker.ts); funnel instances did not. Unlike those, a
-- WAITING funnel instance can legitimately stay WAITING for days by
-- design (a WAIT node's delay), so "how long has it been WAITING" is the
-- wrong staleness signal - resume_at records the real, computed moment
-- the delayed funnel_advance job is expected to fire, so a sweep can
-- detect "that moment passed and the instance is still WAITING" instead.
ALTER TABLE funnel_instances ADD COLUMN resume_at TIMESTAMPTZ;

CREATE INDEX idx_funnel_instances_stale_waiting
  ON funnel_instances (resume_at)
  WHERE status = 'WAITING';
