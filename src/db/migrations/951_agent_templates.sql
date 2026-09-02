-- Real, system-owned starter templates for the "Build My Agent" guided
-- setup flow. Deliberately just two rows (Personal Assistant, Property
-- Operations Assistant) - Property is the only vertical with real backing
-- functionality today (see project constraints), and both templates
-- recommend the identical real tool set (get_current_time,
-- update_conversation_memory, schedule_google_meet, schedule_zoom_meeting)
-- since no property-data AI tool exists yet - pretending otherwise would
-- advertise a capability that isn't real.
CREATE TABLE agent_templates (
  id                          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  template_key                TEXT        NOT NULL UNIQUE,
  name                        TEXT        NOT NULL,
  role                        TEXT        NOT NULL,
  description                 TEXT        NOT NULL,
  category                    TEXT        NOT NULL,
  default_persona             TEXT,
  default_tone                TEXT,
  default_system_instruction  TEXT        NOT NULL,
  default_greeting            TEXT,
  default_trigger_keywords    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  recommended_tools           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  version                     INTEGER     NOT NULL DEFAULT 1,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Reuses the existing (022) allowed_tools/forbidden_tools JSONB columns,
-- which have been real but completely dead since the very first ai_agents
-- migration - never read anywhere in aiReplyService.ts, not even mapped
-- into AiAgentRecord. Every existing agent has an empty allowed_tools
-- array today, which must keep meaning "no restriction" for backward
-- compatibility - this flag is what actually turns the allow-list on, so
-- only an agent created/edited through the new capability-toggle UI gets
-- a real restriction enforced.
ALTER TABLE ai_agents ADD COLUMN allowed_tools_enabled BOOLEAN NOT NULL DEFAULT false;

INSERT INTO agent_templates
  (template_key, name, role, description, category, default_tone, default_system_instruction, default_greeting, default_trigger_keywords, recommended_tools)
VALUES
(
  'personal_assistant',
  'Alex',
  'Personal Assistant',
  'Helps manage schedules, follow-ups, and meetings.',
  'general',
  'warm',
  'You are Alex, a personal assistant. You help the person you work for stay on top of their schedule and commitments. Keep replies short and direct - this is WhatsApp, not email. When someone wants to schedule a call, confirm the date, time, and their email if a Google Meet invite needs to go out, then use the meeting-booking tool to actually create it - never say a meeting is booked unless the tool confirms it really was. If you do not have a capability someone asks for, say so plainly instead of guessing or promising something you cannot do.',
  'Hi! How can I help today?',
  '[]',
  '["get_current_time","update_conversation_memory","schedule_google_meet","schedule_zoom_meeting"]'
),
(
  'property_operations_assistant',
  'Property Assistant',
  'Property Operations Assistant',
  'Helps with tenant communication, appointment scheduling, and follow-ups.',
  'bookings',
  'professional',
  'You are the Property Operations Assistant for this property management business. You handle tenant and prospective-tenant communication over WhatsApp: answering questions about viewings, availability, and appointments, and scheduling a call or video walkthrough when someone wants one. When scheduling, confirm the date, time, and their email if needed, then use the meeting-booking tool to actually create it - never claim a meeting is booked unless the tool confirms it really was. You do not have access to maintenance requests, work orders, or tenant account records yet - if someone asks about those, say so honestly and let them know a team member will follow up, rather than guessing or inventing an answer.',
  'Hi, thanks for reaching out! How can I help?',
  '["viewing","maintenance","appointment","inspection"]',
  '["get_current_time","update_conversation_memory","schedule_google_meet","schedule_zoom_meeting"]'
);
