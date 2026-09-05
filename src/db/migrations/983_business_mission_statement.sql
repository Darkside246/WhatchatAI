-- A real, first-class home for a business's Motto/Vision/Mission (previously
-- only "Motto" existed, buried as a free-text line inside the "Business
-- Profile" knowledge-base document with no way to hide it from the AI).
-- One combined on/off switch controls whether all three are fed to the AI
-- at once - the raw text always stays here regardless of the switch, so
-- toggling it off never loses what was typed (see workspaceService.ts's
-- setMissionStatement, which keeps the auto-generated knowledge-base
-- document in sync with this switch separately).
ALTER TABLE businesses ADD COLUMN motto TEXT;
ALTER TABLE businesses ADD COLUMN vision TEXT;
ALTER TABLE businesses ADD COLUMN mission TEXT;
ALTER TABLE businesses ADD COLUMN mission_statement_ai_visible BOOLEAN NOT NULL DEFAULT true;
