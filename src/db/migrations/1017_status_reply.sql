-- Let an operator reply to a customer's status from the Status section.
--
-- Statuses were read-only: you could see that a customer had posted
-- something, and had no way to respond without leaving Aura for your phone.
--
-- A WhatsApp status reply is not a special message type - it is an ordinary
-- direct message to the person who posted, which QUOTES the status so both
-- sides see it threaded under the right post. Without that quote the
-- recipient just gets a bare message with no idea what it is about, which is
-- why this needs to be recorded rather than approximated.
--
-- Hence a reference rather than a new message type: the row stays an
-- ordinary 'text' send with its real text_content, and this column carries
-- the one extra thing the dispatcher needs to attach the quote.
--
-- ON DELETE SET NULL: a status expires after 24 hours and its row can be
-- cleaned up, which must never delete the reply that was sent about it. A
-- send whose status has since gone is delivered as a plain message rather
-- than failing - the message itself is still real and still wanted.

ALTER TABLE whatsapp_outbound_messages
  ADD COLUMN IF NOT EXISTS reply_to_status_id uuid REFERENCES whatsapp_statuses(id) ON DELETE SET NULL;
