-- scheduled_meetings (947_scheduled_meetings.sql) was built Google-only.
-- Zoom is a second, independent connection type - not a row in
-- google_meeting_connections - so this reshapes the table to hold exactly
-- one of a google_connection_id / zoom_connection_id per row, matching
-- whichever provider the row belongs to.
ALTER TABLE scheduled_meetings RENAME COLUMN connection_id TO google_connection_id;
ALTER TABLE scheduled_meetings ALTER COLUMN google_connection_id DROP NOT NULL;

ALTER TABLE scheduled_meetings ADD COLUMN zoom_connection_id UUID REFERENCES zoom_meeting_connections (id) ON DELETE CASCADE;

ALTER TABLE scheduled_meetings ADD CONSTRAINT scheduled_meetings_exactly_one_connection CHECK (
  (provider = 'google_meet' AND google_connection_id IS NOT NULL AND zoom_connection_id IS NULL) OR
  (provider = 'zoom'        AND zoom_connection_id   IS NOT NULL AND google_connection_id IS NULL)
);

ALTER TABLE scheduled_meetings DROP CONSTRAINT scheduled_meetings_provider_check;
ALTER TABLE scheduled_meetings ADD CONSTRAINT scheduled_meetings_provider_check CHECK (provider IN ('google_meet', 'zoom'));

-- Zoom has no calendar-invite concept - the AI delivers the join_url
-- directly in the WhatsApp reply, so collecting an email is optional
-- (kept only for CRM correlation when the model has one), not load-bearing
-- the way it is for Google's real emailed invite.
ALTER TABLE scheduled_meetings ALTER COLUMN attendee_email DROP NOT NULL;

DROP INDEX idx_scheduled_meetings_external_event;
CREATE UNIQUE INDEX idx_scheduled_meetings_external_event ON scheduled_meetings (provider, external_event_id);
