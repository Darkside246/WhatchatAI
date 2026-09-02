-- Real template inheritance tracking (AURA Master Engineering Prompt
-- section 35: "System templates themselves must remain protected... a
-- user's modification must create an override/custom version rather
-- than corrupting the global system template" and section 34: "when
-- Aura improves a template, do not silently destroy user
-- customisations"). An agent created from a template already gets its
-- own independent ai_agents row today (editing it can never corrupt the
-- template) - what's missing is knowing WHICH template/version an agent
-- came from, so the UI can honestly say "this template has since been
-- updated" without ever auto-applying anything.
--
-- Deliberately nullable and set only at creation time (see
-- workspaceService.ts's createAgentFromTemplate) - a manually-created or
-- custom-description agent has no source template and that must stay
-- representable, not defaulted to some fake template.
ALTER TABLE ai_agents ADD COLUMN source_template_key TEXT REFERENCES agent_templates(template_key) ON DELETE SET NULL;
ALTER TABLE ai_agents ADD COLUMN source_template_version INTEGER;
