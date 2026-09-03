-- Section 56 (unified Appointment System) of the AURA master directive:
-- extends scheduled_meetings' status lifecycle beyond confirmed/cancelled/
-- failed. 'completed' is set automatically by a real sweep once a
-- confirmed meeting's end_at has passed - a real, computable fact, not a
-- guess. 'no_show' is deliberately NOT automatic (whether someone actually
-- attended is not something this system can know on its own) - it is only
-- ever set by an explicit human action.
ALTER TABLE scheduled_meetings DROP CONSTRAINT scheduled_meetings_status_check;
ALTER TABLE scheduled_meetings ADD CONSTRAINT scheduled_meetings_status_check
  CHECK (status IN ('confirmed', 'cancelled', 'failed', 'completed', 'no_show'));
