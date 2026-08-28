-- Persist execution outcome on action requests so the ActionBus idempotency
-- cache survives server restarts.
ALTER TABLE platform_action_requests
  ADD COLUMN IF NOT EXISTS execution_result JSONB,
  ADD COLUMN IF NOT EXISTS execution_error  TEXT;
