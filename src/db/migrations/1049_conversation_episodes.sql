-- Remembering that a conversation ended.
--
-- The agent already decides, turn by turn, whether it has anything to say,
-- and when it does not the pipeline records "the agent judged the exchange
-- closed and chose to say nothing". That judgement was made fresh every
-- time against no memory of ever having made it, and nothing anywhere
-- recorded that the conversation had finished. Seen in the live logs:
-- three consecutive customer messages, three consecutive silences, each one
-- decided from scratch.
--
-- Two failures came out of that. The agent went quiet on customers who were
-- still waiting, because one turn's judgement of "closed" is exactly the
-- call a model gets wrong on a short message and nothing checked it. And
-- when a customer came back hours later, their message arrived at the
-- bottom of a long transcript the model read as one continuous thread, so
-- it answered a conversation that had already ended rather than the
-- sentence in front of it.
--
-- These two columns are the memory. closed_at_message_id is the message the
-- agent was looking at when it closed; everything up to and including it is
-- a previous conversation. The next message FROM THE CUSTOMER opens a new
-- one - the operator's own messages and the assistant's do not, or it would
-- wake itself and answer its own colleague.
--
-- Nullable, and null is the normal state: a conversation that has never
-- been closed behaves exactly as it does today.

ALTER TABLE conversation_states
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE conversation_states
  ADD COLUMN IF NOT EXISTS closed_at_message_id UUID;

/* Deliberately NOT a foreign key to whatsapp_messages. This is a watermark,
   not a relationship: if the message it points at is later deleted - by the
   customer, by a retention sweep - the right outcome is a boundary that no
   longer resolves and a conversation that reads as wholly current (see
   splitEpisode), never a cascade that rewrites history or a delete that
   fails because the AI once stopped talking there. */
COMMENT ON COLUMN conversation_states.closed_at_message_id IS
  'Watermark only - the last message of the previous conversation. Intentionally not a foreign key.';
