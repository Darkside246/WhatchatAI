-- Close the AI-message attribution race, WITHOUT putting anything new on the
-- WhatsApp ingestion path.
--
-- The race: an AI reply's whatsapp_outbound_messages row is created and sent
-- before WhatsApp echoes the message back as a whatsapp_messages row. The
-- application-side link (linkPersistedMessage) runs only once that echo has
-- been persisted, so during that window an AI-generated fromMe message is
-- indistinguishable from a human operator's manual reply - which is exactly
-- how the model can later attribute a business-side statement to the wrong
-- author, or how the AI's own reply can be mistaken for a human takeover.
--
-- The upstream version of this migration closed that window with an
-- AFTER INSERT trigger on whatsapp_messages. That is deliberately NOT done
-- here. Three real problems with it, all of which land on the Baileys
-- ingestion path:
--
--   1. It fires FOR EACH ROW on every inserted message, inbound included.
--      Inbound customer messages are the overwhelming majority of inserts
--      and can never match an outbound row, so every one of them paid for a
--      wasted UPDATE inside persistWithClient's own transaction.
--   2. whatsapp_outbound_messages rows are already written concurrently by
--      the send path (markSent/updateStatus) and by linkPersistedMessage.
--      Adding a third writer that takes row locks from inside the message
--      INSERT transaction invites lock waits and deadlock aborts - and a
--      deadlock there rolls back the whole message persist, so the message
--      insert fails, the BullMQ job retries, and the ingestion backlog
--      grows. From the outside that looks exactly like the WhatsApp
--      connection misbehaving.
--   3. Its historical repair was a single unbounded UPDATE over the whole
--      table, executed at container start when migrations run - a long
--      lock-holding transaction competing with a worker that is trying to
--      reconnect.
--
-- Instead, the relationship is resolved on the READ side, by matching the
-- provider's own whatsapp_message_id (recorded by markSent() the instant our
-- send call returns, i.e. before any echo exists) as well as the linked
-- message_id. See WhatsAppOutboundMessageRepository.listAiGeneratedMessageIds.
-- That is race-free by construction, needs no write at all, and leaves the
-- ingestion transaction and the Baileys connection completely untouched.
--
-- All this migration contributes is the index that read needs. Attribution is
-- keyed on real provider/account identity - never on message text, contact
-- names, phone numbers, or model output.

CREATE INDEX IF NOT EXISTS whatsapp_outbound_messages_message_identity_idx
  ON whatsapp_outbound_messages (business_id, whatsapp_account_id, whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

-- Defensive: if a previous deployment installed the upstream trigger, remove
-- it. Idempotent, and a no-op on an installation that never had it.
DROP TRIGGER IF EXISTS trg_link_outbound_message_to_persisted_whatsapp_message
  ON whatsapp_messages;
DROP FUNCTION IF EXISTS link_outbound_message_to_persisted_whatsapp_message();
