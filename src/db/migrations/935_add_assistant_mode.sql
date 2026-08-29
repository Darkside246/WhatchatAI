-- The named AI personal-assistant mode, layered on top of the existing
-- Operator Mode PIN session rather than a new auth mechanism (see
-- entitlementService.ts and assistantModeService.ts) - a business names
-- their assistant, and an already-authenticated operator can switch that
-- one session between rigid command parsing and natural-language routing.

ALTER TABLE operator_settings
  ADD COLUMN assistant_name TEXT;

ALTER TABLE operator_sessions
  ADD COLUMN interaction_mode TEXT NOT NULL DEFAULT 'COMMAND'
    CHECK (interaction_mode IN ('COMMAND', 'ASSISTANT'));
