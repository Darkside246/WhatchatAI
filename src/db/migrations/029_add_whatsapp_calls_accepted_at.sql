-- Real call duration must be measured from when a call was actually
-- answered to when it ended, not from when it started ringing - a missed
-- or rejected call was never connected and has no meaningful duration.
ALTER TABLE whatsapp_calls ADD COLUMN accepted_at TIMESTAMPTZ;
