-- Operator Mode "ai off"/"ai on"/"ai off until X" commands: a real,
-- business-wide bulk pause (see whatsappChatRepository.ts's
-- pauseAllForOperator/resumeAllPausedByOperator). This column is purely for
-- the "ai status" command to answer "paused until when" without needing to
-- inspect the BullMQ scheduler - null means either never paused this way,
-- or paused with no timed resume (an indefinite "ai off").
ALTER TABLE businesses ADD COLUMN ai_operator_paused_until TIMESTAMPTZ;

-- Promotes the reminder feature (previously reachable only inside a named
-- assistant-mode session) to a plain top-level Operator Mode command
-- ("remind me [text] at [time]") - reuses the exact same reminders table
-- and delivery sweep already built for assistant mode, no new mechanism.
-- (No schema change needed here - the reminders table and its RLS/GRANTs
-- already exist; this comment documents the new caller for anyone tracing
-- INSERTs into this table later.)
