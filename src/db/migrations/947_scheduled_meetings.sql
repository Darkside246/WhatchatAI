-- Real audit/history of every meeting AURA has actually created via
-- scheduleMeetingTool.ts - never a UI-only record. Structured so a future
-- dashboard can list "meetings for this chat/contact" without another
-- migration, even though no such UI exists yet.
CREATE TABLE scheduled_meetings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  chat_id               UUID        REFERENCES whatsapp_chats (id) ON DELETE SET NULL,
  contact_id            UUID        REFERENCES crm_contacts (id) ON DELETE SET NULL,
  agent_id              UUID        REFERENCES ai_agents (id) ON DELETE SET NULL,
  connection_id         UUID        NOT NULL REFERENCES google_meeting_connections (id) ON DELETE CASCADE,

  provider              TEXT        NOT NULL DEFAULT 'google_meet' CHECK (provider IN ('google_meet')),
  status                TEXT        NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'cancelled', 'failed')),

  title                 TEXT        NOT NULL,
  start_at              TIMESTAMPTZ NOT NULL,
  end_at                TIMESTAMPTZ NOT NULL,
  timezone              TEXT        NOT NULL,

  attendee_email        TEXT        NOT NULL,
  attendee_name         TEXT,

  external_event_id     TEXT        NOT NULL,
  meet_url              TEXT        NOT NULL,
  calendar_html_link    TEXT,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  cancelled_at          TIMESTAMPTZ
);

CREATE INDEX idx_scheduled_meetings_business ON scheduled_meetings (business_id);
CREATE INDEX idx_scheduled_meetings_chat ON scheduled_meetings (chat_id);
CREATE UNIQUE INDEX idx_scheduled_meetings_external_event ON scheduled_meetings (connection_id, external_event_id);
