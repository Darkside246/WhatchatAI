-- Whether WhatsApp Channel activity may raise notifications.
--
-- Channels are broadcast feeds a business follows - a news channel, a
-- supplier's announcements. They are not conversations: nobody is waiting on
-- a reply, and there is nothing to action. Letting them raise dashboard
-- notifications would bury the things that genuinely need a person (a
-- customer waiting on a human, a failed send) under a feed nobody asked to
-- be interrupted by.
--
-- So the default is OFF, and this is the switch that turns it on for a
-- business that genuinely wants it. Defaulting to off rather than on is
-- deliberate: an existing business that has never expressed a preference
-- should not suddenly start receiving a new class of notification because
-- this column appeared.
--
-- Chat-level behaviour is unchanged: a channel's posts are still ingested
-- and still readable in the Channels view. This governs notifications only.

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS channel_notifications_enabled boolean NOT NULL DEFAULT false;
