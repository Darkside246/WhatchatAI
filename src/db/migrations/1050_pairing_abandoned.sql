-- Stop asking a QR code nobody is going to scan.
--
-- An account with no session does this, forever, roughly every thirty
-- seconds, for as long as the process lives:
--
--   connected to WA -> "not logged in, attempting registration"
--   -> a QR is generated -> nobody scans it
--   -> "QR refs attempts ended" -> close (408) -> reconnect -> repeat
--
-- Two businesses were doing exactly that in production for hours. The
-- exponential backoff was working correctly and capping at thirty seconds,
-- which is the problem: nothing ever decided to stop. A QR is an invitation
-- to a person, and when there is no person there, reissuing it two thousand
-- times a day achieves nothing except CPU on a small droplet and a log so
-- noisy that real problems cannot be read out of it.
--
-- So after a bounded number of pairing cycles that nobody answered, the
-- automatic loop stops and the account says what it is waiting for. This
-- is not a failure state and nothing is destroyed: the session directory
-- is untouched, and a person opening the pairing screen and asking to
-- connect starts it again immediately with the counter reset.
--
-- Deliberately narrow. The counter only advances on a cycle that actually
-- issued a QR and never reached 'open' - that is what "nobody is pairing
-- this" looks like. A paired account dropping on a flaky network never
-- issues a QR, so it keeps retrying forever exactly as it does today. That
-- distinction is the whole safety argument: this must never be able to give
-- up on a working connection.
--
-- Follows migration 931 exactly, which did the same for the reconnect storm
-- caused by DisconnectReason.connectionReplaced.

ALTER TABLE whatsapp_connection_events DROP CONSTRAINT whatsapp_connection_events_event_type_check;
ALTER TABLE whatsapp_connection_events ADD CONSTRAINT whatsapp_connection_events_event_type_check CHECK (event_type IN (
  'connecting', 'qr_generated', 'connected', 'disconnected', 'reconnecting', 'logged_out',
  'conflict_replaced', 'pairing_abandoned', 'error'
));

ALTER TABLE whatsapp_accounts DROP CONSTRAINT whatsapp_accounts_connection_status_check;
ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_connection_status_check CHECK (connection_status IN (
  'DISCONNECTED', 'CONNECTING', 'QR_READY', 'CONNECTED',
  'RECONNECTING', 'LOGGED_OUT', 'CONFLICT_REPLACED', 'PAIRING_ABANDONED', 'ERROR'
));
