-- The Property Operations Assistant template (951) could only honestly
-- recommend meeting-booking + memory when it was seeded, since no
-- property-data tool existed yet. list_properties/check_property_status
-- now exist (aiToolPolicy.ts) and reuse the real, already-live
-- PropertyOperationsRepository - update the existing template row rather
-- than leaving already-created agents (and the seed data new agents copy
-- from) undersold. Deliberately does not touch personal_assistant, which
-- has no legitimate use for property tools.
UPDATE agent_templates
SET recommended_tools = '["get_current_time","update_conversation_memory","schedule_google_meet","schedule_zoom_meeting","list_properties","check_property_status"]'::jsonb,
    updated_at = now()
WHERE template_key = 'property_operations_assistant';
