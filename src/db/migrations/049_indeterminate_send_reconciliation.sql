-- Closes a real, previously-admitted gap (see the comment above
-- processOutboundMessage in outboundDispatchWorker.ts): if this process
-- crashes after WhatsApp has already accepted a send but before the DB
-- commit recording that, a naive retry would call sendMessage a second
-- time and produce a real duplicate message. WhatsApp gives clients no
-- server-side dedup key for outbound sends, so the only safe fix on the
-- client side is to record, durably, the instant BEFORE the risky call is
-- made - so a resumed/retried attempt can tell "never reached the
-- provider, safe to retry" apart from "may have reached the provider,
-- must not blindly retry."
ALTER TABLE whatsapp_outbound_messages
  ADD COLUMN send_attempted_at TIMESTAMPTZ;

ALTER TABLE whatsapp_outbound_messages DROP CONSTRAINT whatsapp_outbound_messages_status_check;
ALTER TABLE whatsapp_outbound_messages
  ADD CONSTRAINT whatsapp_outbound_messages_status_check
    CHECK (status IN ('queued', 'sending', 'sent', 'failed', 'indeterminate'));

-- Same class of gap for email: sendEmail() itself never leaves an unknown
-- state (it catches its own errors), but a crash between that call
-- returning 'sent' and markSent() committing leaves the row stuck in
-- 'sending' forever - markSending() only ever re-claims a row that is
-- 'approved', so a stuck 'sending' row is silently invisible today, with
-- no sweep to reconcile it (unlike whatsapp_outbound_messages, which
-- already has one). 'indeterminate' lets that reconciliation state an
-- honest "we don't know" instead of a false 'failed'.
ALTER TABLE email_messages
  ADD COLUMN send_attempted_at TIMESTAMPTZ;

ALTER TABLE email_messages DROP CONSTRAINT email_messages_status_check;
ALTER TABLE email_messages
  ADD CONSTRAINT email_messages_status_check
    CHECK (status IN ('draft', 'approved', 'sending', 'sent', 'failed', 'cancelled', 'indeterminate'));

-- 'indeterminate' only ever comes from a row that was already approved and
-- mid-send, so it belongs in the same "must have a real approver" branch as
-- approved/sending/sent, not the no-approver branch.
ALTER TABLE email_messages DROP CONSTRAINT email_approved_has_approver;
ALTER TABLE email_messages
  ADD CONSTRAINT email_approved_has_approver CHECK (
    (status IN ('approved', 'sending', 'sent', 'indeterminate') AND approved_by IS NOT NULL AND approved_at IS NOT NULL)
    OR status IN ('draft', 'failed', 'cancelled')
  );
