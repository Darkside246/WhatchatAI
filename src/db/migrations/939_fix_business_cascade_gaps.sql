-- Prerequisite for real business deletion (accountDeletionService.ts):
-- these 28 tables' business_id foreign key predates this schema's later
-- ON DELETE CASCADE convention and defaults to Postgres's RESTRICT-like
-- NO ACTION - confirmed live against a real database
-- (SELECT conrelid::regclass, conname, confdeltype FROM pg_constraint
--  WHERE contype = 'f' AND confrelid = 'businesses'::regclass AND
--  confdeltype != 'c'), not assumed from migration history. Every real
-- trial business has rows in several of these (whatsapp_accounts,
-- subscriptions, security_audit_logs at minimum), so a plain
-- DELETE FROM businesses throws today. All 28 constraints use Postgres's
-- default naming (<table>_business_id_fkey) - also confirmed live, not
-- assumed.
ALTER TABLE ai_agent_prompt_optimizations DROP CONSTRAINT ai_agent_prompt_optimizations_business_id_fkey,
  ADD CONSTRAINT ai_agent_prompt_optimizations_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE ai_agents DROP CONSTRAINT ai_agents_business_id_fkey,
  ADD CONSTRAINT ai_agents_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE conversation_events DROP CONSTRAINT conversation_events_business_id_fkey,
  ADD CONSTRAINT conversation_events_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE conversation_states DROP CONSTRAINT conversation_states_business_id_fkey,
  ADD CONSTRAINT conversation_states_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE crm_contacts DROP CONSTRAINT crm_contacts_business_id_fkey,
  ADD CONSTRAINT crm_contacts_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE customer_identities DROP CONSTRAINT customer_identities_business_id_fkey,
  ADD CONSTRAINT customer_identities_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE customers DROP CONSTRAINT customers_business_id_fkey,
  ADD CONSTRAINT customers_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE leads DROP CONSTRAINT leads_business_id_fkey,
  ADD CONSTRAINT leads_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
-- security_lock_credentials.business_id is separately UNIQUE - only the
-- _fkey constraint is touched here, that unique constraint is untouched.
ALTER TABLE security_lock_credentials DROP CONSTRAINT security_lock_credentials_business_id_fkey,
  ADD CONSTRAINT security_lock_credentials_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
-- security_audit_logs itself is the account-deletion audit trail (see
-- accountDeletionService.ts) - the 'account_deletion_requested' row
-- written when deletion is requested cascades away at final purge along
-- with everything else, which is correct: it is per-business operational
-- history, not a standalone compliance record.
ALTER TABLE security_audit_logs DROP CONSTRAINT security_audit_logs_business_id_fkey,
  ADD CONSTRAINT security_audit_logs_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE subscription_events DROP CONSTRAINT subscription_events_business_id_fkey,
  ADD CONSTRAINT subscription_events_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_business_id_fkey,
  ADD CONSTRAINT subscriptions_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE usage_counters DROP CONSTRAINT usage_counters_business_id_fkey,
  ADD CONSTRAINT usage_counters_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_accounts DROP CONSTRAINT whatsapp_accounts_business_id_fkey,
  ADD CONSTRAINT whatsapp_accounts_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_calls DROP CONSTRAINT whatsapp_calls_business_id_fkey,
  ADD CONSTRAINT whatsapp_calls_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_chats DROP CONSTRAINT whatsapp_chats_business_id_fkey,
  ADD CONSTRAINT whatsapp_chats_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_connection_events DROP CONSTRAINT whatsapp_connection_events_business_id_fkey,
  ADD CONSTRAINT whatsapp_connection_events_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_contacts DROP CONSTRAINT whatsapp_contacts_business_id_fkey,
  ADD CONSTRAINT whatsapp_contacts_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_group_members DROP CONSTRAINT whatsapp_group_members_business_id_fkey,
  ADD CONSTRAINT whatsapp_group_members_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_groups DROP CONSTRAINT whatsapp_groups_business_id_fkey,
  ADD CONSTRAINT whatsapp_groups_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_jid_mappings DROP CONSTRAINT whatsapp_jid_mappings_business_id_fkey,
  ADD CONSTRAINT whatsapp_jid_mappings_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_media DROP CONSTRAINT whatsapp_media_business_id_fkey,
  ADD CONSTRAINT whatsapp_media_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_message_reactions DROP CONSTRAINT whatsapp_message_reactions_business_id_fkey,
  ADD CONSTRAINT whatsapp_message_reactions_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_messages DROP CONSTRAINT whatsapp_messages_business_id_fkey,
  ADD CONSTRAINT whatsapp_messages_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_outbound_messages DROP CONSTRAINT whatsapp_outbound_messages_business_id_fkey,
  ADD CONSTRAINT whatsapp_outbound_messages_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_presence DROP CONSTRAINT whatsapp_presence_business_id_fkey,
  ADD CONSTRAINT whatsapp_presence_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_statuses DROP CONSTRAINT whatsapp_statuses_business_id_fkey,
  ADD CONSTRAINT whatsapp_statuses_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
ALTER TABLE whatsapp_sync_jobs DROP CONSTRAINT whatsapp_sync_jobs_business_id_fkey,
  ADD CONSTRAINT whatsapp_sync_jobs_business_id_fkey FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE;
