-- Zoom OAuth connection per business - mirrors google_meeting_connections
-- (946_google_meeting_connections.sql) exactly. A separate table, not a
-- shared polymorphic one, since Zoom is a fully independent OAuth app/token
-- lifecycle from Google's.
CREATE TABLE zoom_meeting_connections (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id           UUID        NOT NULL REFERENCES businesses (id) ON DELETE CASCADE,
  zoom_email            TEXT        NOT NULL,
  zoom_user_id          TEXT        NOT NULL,
  display_name          TEXT,
  access_token_enc      TEXT        NOT NULL,
  refresh_token_enc     TEXT,
  token_expires_at      TIMESTAMPTZ,
  scopes                TEXT,
  connected_by_user_id  UUID        REFERENCES users (id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX idx_zoom_meeting_connections_business ON zoom_meeting_connections (business_id);
