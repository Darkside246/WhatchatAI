-- A screened-out message is held, not hidden.
--
-- The Security Sentinel screens customer-originated content for prompt
-- injection, jailbreaks and social engineering before the AI ever sees it.
-- That part is right and stays exactly as it is. What was wrong is what
-- happened next: a blocked message was dropped on the floor - never
-- persisted, never shown, never counted. The customer saw their message
-- send. The operator never saw it arrive.
--
-- Reported from a real chat: a customer asked a question containing the
-- word "password" and it simply never appeared. Nobody was told. There is
-- no worse failure in a messaging product than silently deleting what
-- somebody said, and "we thought it might be an attack" is a reason to
-- withhold it from the ROBOT, not from the human being paid to read it.
--
-- So the message is now stored like any other and marked. The security
-- property is unchanged - held text is excluded from every path that
-- reaches the model (see listByChatForAgent and findUnansweredInboundSince)
-- - but the operator sees the message, sees that it was held, and sees why.
--
-- 'passed' is the default, so every row that already exists, and every
-- message that arrives through the ordinary path, is exactly what it was.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS screening_status TEXT NOT NULL DEFAULT 'passed';

ALTER TABLE whatsapp_messages
  DROP CONSTRAINT IF EXISTS whatsapp_messages_screening_status_check;
ALTER TABLE whatsapp_messages
  ADD CONSTRAINT whatsapp_messages_screening_status_check
  CHECK (screening_status IN ('passed', 'held'));

/* Why it was held, in the Sentinel's own words, so the operator reading it
   can judge for themselves rather than being told only that something was
   wrong. Never the message text - that is already in text_content. */
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS screening_reason TEXT;

/* Partial, because held is the rare case by design: this indexes the
   handful of rows a review screen would ever ask for, and costs nothing on
   the millions that passed. */
CREATE INDEX IF NOT EXISTS whatsapp_messages_held_idx
  ON whatsapp_messages (business_id, "timestamp" DESC)
  WHERE screening_status = 'held' AND deleted_at IS NULL;
