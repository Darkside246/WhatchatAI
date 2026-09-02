-- Extends the Row-Level Security backstop from migration 944 (which covered
-- only whatsapp_chats, whatsapp_messages, ai_agents, crm_contacts) to every
-- other real tenant-scoped table in the schema - a database-enforced
-- backstop for the business_id filter application code already applies,
-- for the ~100-tenant launch push. Same mechanism as 944: the app's own
-- login role (whatchatai) is a Postgres superuser and always bypasses RLS
-- unconditionally - that's a hard Postgres guarantee, not something this
-- migration can or should try to change. Only code that explicitly opts in
-- via db/pool.ts's queryAsTenant() (which switches into the restricted
-- whatchatai_tenant role for one transaction) is ever actually bound by
-- these policies. Ordinary application queries through the main pool are
-- entirely unaffected by this migration.
--
-- Deliberately excluded: tables with no real business_id column at all
-- (users, user_preferences, auth_login_attempts, businesses itself,
-- product_catalog, team_members, campaign_recipients, funnel_steps,
-- product_entitlements, product_account_provisioning_events - these are
-- either global or scoped only through a parent row's business_id, not
-- their own column, so a business_id-based policy cannot apply to them
-- directly).

GRANT SELECT, INSERT, UPDATE, DELETE ON
  whatsapp_accounts, whatsapp_contacts, whatsapp_groups, whatsapp_group_members,
  whatsapp_message_reactions, whatsapp_media, whatsapp_presence, whatsapp_calls,
  whatsapp_statuses, whatsapp_connection_events, whatsapp_sync_jobs, whatsapp_jid_mappings,
  whatsapp_outbound_messages,
  subscriptions, subscription_events, usage_counters, product_accounts,
  leads, customers, customer_identities,
  security_audit_logs, security_lock_credentials,
  business_memberships, sessions,
  notifications, teams, agent_capacity,
  campaigns, scheduled_statuses, funnel_definitions, funnel_instances,
  business_email_settings, email_messages, email_oauth_accounts, business_goose_settings,
  knowledge_base_documents, business_documents, business_document_versions, business_document_chunks,
  ai_agent_prompt_optimizations,
  openclaw_tool_executions, openclaw_cells,
  property_properties, property_units, property_assets, property_vendors,
  property_reservations, property_incidents, property_work_orders,
  property_knowledge_items, property_safety_policies, property_notes, property_conversation_bindings,
  platform_agents, platform_skills, platform_agent_tasks, platform_action_requests,
  platform_approvals, platform_audit_events,
  conversation_states, conversation_events,
  google_meeting_connections, scheduled_meetings, zoom_meeting_connections,
  business_unit_aliases, maintenance_triage_feedback,
  operator_settings, operator_sessions, operator_wa_setup_tokens,
  invoices, invoice_line_items, invoice_number_sequences,
  reminders, ai_usage_events, ai_commitments
  TO whatchatai_tenant;

ALTER TABLE whatsapp_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_group_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_message_reactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_connection_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_sync_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_jid_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customer_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE security_lock_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_statuses ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE funnel_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_oauth_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_goose_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_base_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_document_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agent_prompt_optimizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_tool_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE openclaw_cells ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_units ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_work_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_knowledge_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_safety_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_conversation_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_action_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_meeting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE zoom_meeting_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_unit_aliases ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_triage_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE operator_wa_setup_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_number_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_usage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_commitments ENABLE ROW LEVEL SECURITY;

-- Same NULLIF(...,'')::uuid pattern as migration 944: an unset session
-- variable reads back as '' (not NULL), and a bare cast of '' to uuid
-- throws rather than matching nothing - this must fail closed (match zero
-- rows) instead of erroring out a query that had no reason to expect
-- tenant scoping. platform_skills.business_id is nullable (a global,
-- non-tenant skill has business_id IS NULL) - such rows are correctly
-- invisible under this policy, since NULL = anything is never true; that
-- only matters once/if a caller starts reading platform_skills through
-- queryAsTenant, which nothing does today.
CREATE POLICY tenant_isolation ON whatsapp_accounts USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_contacts USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_groups USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_group_members USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_message_reactions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_media USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_presence USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_calls USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_statuses USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_connection_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_sync_jobs USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_jid_mappings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_outbound_messages USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON subscriptions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON subscription_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON usage_counters USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON product_accounts USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON leads USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON customers USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON customer_identities USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON security_audit_logs USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON security_lock_credentials USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON business_memberships USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON sessions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON notifications USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON teams USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON agent_capacity USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON campaigns USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON scheduled_statuses USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON funnel_definitions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON funnel_instances USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON business_email_settings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON email_messages USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON email_oauth_accounts USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON business_goose_settings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON knowledge_base_documents USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON business_documents USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON business_document_versions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON business_document_chunks USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON ai_agent_prompt_optimizations USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON openclaw_tool_executions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON openclaw_cells USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_properties USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_units USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_assets USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_vendors USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_reservations USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_incidents USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_work_orders USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_knowledge_items USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_safety_policies USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_notes USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON property_conversation_bindings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON platform_agents USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON platform_skills USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON platform_agent_tasks USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON platform_action_requests USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON platform_approvals USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON platform_audit_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON conversation_states USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON conversation_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON google_meeting_connections USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON scheduled_meetings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON zoom_meeting_connections USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON business_unit_aliases USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON maintenance_triage_feedback USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON operator_settings USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON operator_sessions USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON operator_wa_setup_tokens USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON invoices USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON invoice_line_items USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON invoice_number_sequences USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON reminders USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON ai_usage_events USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON ai_commitments USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
