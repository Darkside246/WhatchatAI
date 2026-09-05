-- Email Redesign Phase C/D: the right-hand tools panel's per-user card
-- order (mirrors navigation_order's existing, previously-unused JSONB
-- array-on-user_preferences shape exactly), a lightweight "notes to
-- self" concept for email (none existed anywhere in this app), and a
-- once-per-day cache for the AI daily-suggestions card so it is never
-- regenerated on every page load.

ALTER TABLE user_preferences ADD COLUMN email_panel_card_order JSONB;

-- Doubles as the tools panel's "Reminders" card: the app's existing
-- `reminders` table turned out to be strictly for messaging a real,
-- existing WhatsApp chat (its notify_jid must resolve to one - see
-- incomingMessagesWorker.ts's sweep) - there is no "remind the signed-in
-- staff member" concept anywhere in this app, so reusing it for an
-- email-context reminder would need a WhatsApp chat picker with no
-- honest connection to the email being read. A plain, optional remind_at
-- on this same notes table instead - "notes with a due date, soonest
-- first" - is a real, coherent feature that promises exactly what it
-- delivers: nothing is sent anywhere, it just surfaces at the top of the
-- panel once due.
CREATE TABLE email_notes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body        TEXT        NOT NULL CHECK (length(body) <= 2000),
  remind_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_email_notes_business_user ON email_notes (business_id, user_id, created_at DESC);
CREATE INDEX idx_email_notes_remind_at ON email_notes (business_id, user_id, remind_at) WHERE remind_at IS NOT NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_notes TO whatchatai_tenant;
ALTER TABLE email_notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_notes USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);

-- One cached row per business per calendar day - the digest generator
-- overwrites today's row rather than appending, so "regenerate" always
-- means a real, deliberate re-run, never a silent multiply of AI calls.
CREATE TABLE email_ai_suggestions (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id   UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  generated_on  DATE        NOT NULL,
  suggestions   JSONB       NOT NULL DEFAULT '[]',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (business_id, generated_on)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON email_ai_suggestions TO whatchatai_tenant;
ALTER TABLE email_ai_suggestions ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_ai_suggestions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
