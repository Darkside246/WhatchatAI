-- Fix a real attribution race in AI conversation history.
--
-- The AI outbound row is created/sent before WhatsApp echoes the message
-- back as a whatsapp_messages row. The existing application-side
-- linkPersistedMessage() can therefore run after a concurrent AI context
-- gather has already queried history. During that window, an AI-generated
-- fromMe message is indistinguishable from a human manual reply and can be
-- labelled as a human message, which is exactly how the model can later
-- misattribute a business-side statement to the customer.
--
-- The trigger makes the database establish the relationship atomically as
-- the persisted WhatsApp message becomes visible. It is deliberately based
-- on the provider's real whatsapp_message_id + account/business identity,
-- never on message text, names, phone numbers, or model output.

CREATE INDEX IF NOT EXISTS whatsapp_outbound_messages_message_identity_idx
  ON whatsapp_outbound_messages (business_id, whatsapp_account_id, whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- Repair historical rows first. This is idempotent and only fills a missing
-- relationship; it never changes requested_by, message content, or delivery
-- state.
UPDATE whatsapp_outbound_messages AS o
SET message_id = m.id,
    updated_at = now()
FROM whatsapp_messages AS m
WHERE o.message_id IS NULL
  AND o.business_id = m.business_id
  AND o.whatsapp_account_id = m.whatsapp_account_id
  AND o.whatsapp_message_id = m.whatsapp_message_id;

CREATE OR REPLACE FUNCTION link_outbound_message_to_persisted_whatsapp_message()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE whatsapp_outbound_messages
  SET message_id = NEW.id,
      updated_at = now()
  WHERE business_id = NEW.business_id
    AND whatsapp_account_id = NEW.whatsapp_account_id
    AND whatsapp_message_id = NEW.whatsapp_message_id
    AND message_id IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_link_outbound_message_to_persisted_whatsapp_message
  ON whatsapp_messages;

CREATE TRIGGER trg_link_outbound_message_to_persisted_whatsapp_message
AFTER INSERT ON whatsapp_messages
FOR EACH ROW
EXECUTE FUNCTION link_outbound_message_to_persisted_whatsapp_message();
