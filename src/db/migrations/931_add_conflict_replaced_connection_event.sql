-- Adds the 'conflict_replaced' event type so whatsappConnectionService.ts
-- can honestly record a Baileys DisconnectReason.connectionReplaced event
-- (WhatsApp's own "another connection took ownership of this session"
-- signal) instead of it being indistinguishable from an ordinary
-- 'disconnected' event. Previously this event type was silently treated
-- like any other disconnect, which is what let the reconnect loop happen
-- in the first place - the fix in whatsappConnectionService.ts stops
-- retrying for this specific reason, and this migration is what lets it
-- record that decision truthfully rather than mislabeling it.
ALTER TABLE whatsapp_connection_events DROP CONSTRAINT whatsapp_connection_events_event_type_check;
ALTER TABLE whatsapp_connection_events ADD CONSTRAINT whatsapp_connection_events_event_type_check CHECK (event_type IN (
  'connecting', 'qr_generated', 'connected', 'disconnected', 'reconnecting', 'logged_out', 'conflict_replaced', 'error'
));

-- Same reasoning: whatsappAccountRepository.markDisconnected() writes this
-- new status onto the account row itself so the account's live
-- connection_status is honest, not silently rejected by a stale
-- constraint.
ALTER TABLE whatsapp_accounts DROP CONSTRAINT whatsapp_accounts_connection_status_check;
ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_connection_status_check CHECK (connection_status IN (
  'DISCONNECTED', 'CONNECTING', 'QR_READY', 'CONNECTED',
  'RECONNECTING', 'LOGGED_OUT', 'CONFLICT_REPLACED', 'ERROR'
));
