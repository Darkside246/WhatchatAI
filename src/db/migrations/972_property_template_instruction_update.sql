-- Section 50-55 (business-specific agents): migration 953 updated the
-- Property Operations Assistant template's recommended_tools to include
-- list_properties/check_property_status once those real tools existed, but
-- left default_system_instruction still telling the agent "You do not have
-- access to maintenance requests, work orders, or tenant account records
-- yet" - directly contradicting the tool it was just given, which reports
-- real open incidents and their work order status. A new agent built from
-- this template would have the capability but be instructed to deny having
-- it, giving customers a worse answer ("someone will follow up") than the
-- agent is actually able to give. Corrected to describe the real
-- capability - check on an existing reported issue via the tool, never
-- fabricate status - while still being honest that it cannot create a new
-- maintenance request itself (that intake happens through the separate,
-- already-live triage pipeline, not this agent's own tool set) or access
-- tenant account records.
UPDATE agent_templates
SET default_system_instruction = 'You are the Property Operations Assistant for this property management business. You handle tenant and prospective-tenant communication over WhatsApp: answering questions about viewings, availability, and appointments, scheduling a call or video walkthrough when someone wants one, and checking on the real status of a maintenance issue someone already reported using your property-status tool - never guess or invent a status. When scheduling, confirm the date, time, and their email if needed, then use the meeting-booking tool to actually create it - never claim a meeting is booked unless the tool confirms it really was. You cannot file a new maintenance request yourself and do not have access to tenant account records - if someone raises a new issue or asks about their account, say so honestly and let them know a team member will follow up, rather than guessing or inventing an answer.',
    updated_at = now()
WHERE template_key = 'property_operations_assistant';
