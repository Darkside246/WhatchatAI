-- Phase 2B: activates BullMQ's already-configured attempts:3/backoff for
-- media downloads with a real, guarded state machine and observability, per
-- docs/PHASE_2A_MEDIA_RETRY_AUDIT_AND_PROPOSAL.md sections 2 and 8. Before
-- this migration, 'failed' was a catch-all for every failure; it now means
-- specifically "terminal, no further automatic attempts" - a retryable
-- failure with attempts remaining lands in the new 'retry_scheduled' state
-- instead.
ALTER TABLE whatsapp_media DROP CONSTRAINT whatsapp_media_download_status_check;
ALTER TABLE whatsapp_media
  ADD CONSTRAINT whatsapp_media_download_status_check
  CHECK (download_status IN ('pending', 'downloading', 'downloaded', 'retry_scheduled', 'failed', 'unavailable'));

ALTER TABLE whatsapp_media
  ADD COLUMN download_attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN last_attempted_at TIMESTAMPTZ,
  ADD COLUMN last_error_category TEXT
    CHECK (last_error_category IN ('network', 'oversized', 'checksum_mismatch', 'expired', 'internal')),
  ADD COLUMN last_error_message TEXT,
  ADD COLUMN next_retry_at TIMESTAMPTZ,
  ADD COLUMN terminal_reason TEXT;

-- Backs the crash-recovery sweep's "find rows stuck in 'downloading'" query
-- (section 4/6 of the proposal), the same pattern the existing
-- call/sync-job/outbound-message/email stale sweeps already use.
CREATE INDEX whatsapp_media_downloading_idx ON whatsapp_media (updated_at) WHERE download_status = 'downloading';
