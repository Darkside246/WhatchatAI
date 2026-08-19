-- A sync job that completed but hit real, recorded errors along the way is
-- neither a clean 'completed' nor a total 'failed' - 'partial' lets the job
-- record say so honestly instead of overstating success.
ALTER TABLE whatsapp_sync_jobs DROP CONSTRAINT whatsapp_sync_jobs_status_check;
ALTER TABLE whatsapp_sync_jobs ADD CONSTRAINT whatsapp_sync_jobs_status_check
  CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled'));
