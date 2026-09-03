-- Section 49 (Emergency controls): once a campaign send starts, every
-- recipient's outbound message is created 'queued' with a real BullMQ
-- delayed job (staggered by SEND_STAGGER_MS so WhatsApp never sees a burst) -
-- but campaignService.cancelCampaign() refused any status other than
-- DRAFT/REVIEW/APPROVED, so a business that spots a mistake seconds after
-- clicking Send (wrong price, wrong recipient list, wrong message) had no
-- way to stop the recipients still waiting in that delay window, which for
-- a few hundred recipients can be tens of minutes. 'cancelled' lets a
-- still-queued row be pulled out of the send path the same way 'sent' and
-- 'indeterminate' already are in outboundDispatchWorker's own guard -
-- never a status a message already 'sending' or 'sent' can move to.
ALTER TABLE whatsapp_outbound_messages DROP CONSTRAINT whatsapp_outbound_messages_status_check;
ALTER TABLE whatsapp_outbound_messages
  ADD CONSTRAINT whatsapp_outbound_messages_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'indeterminate', 'cancelled'));
