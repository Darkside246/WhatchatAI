-- Row-Level Security for the core tenant tables (whatsapp_chats,
-- whatsapp_messages, ai_agents, crm_contacts) - a database-enforced
-- backstop for the business_id filter every repository query already
-- applies in application code. Verified true today by direct inspection,
-- but it's a convention, not a guarantee; this makes the database itself
-- refuse to return another tenant's rows even if a future query forgets
-- the filter.
--
-- The app's own DB role (whatchatai) is a superuser and therefore always
-- bypasses RLS regardless of policy or FORCE ROW LEVEL SECURITY - that is
-- a hard, unconditional Postgres guarantee, not a misconfiguration to fix
-- here. A separate, non-superuser role is required for RLS to actually
-- bind. Ordinary application queries are entirely unaffected by this
-- migration; only queries explicitly run through db/pool.ts's
-- queryAsTenant() helper switch into this restricted role for the
-- duration of one transaction, and only those are bound by these
-- policies.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'whatchatai_tenant') THEN
    CREATE ROLE whatchatai_tenant NOLOGIN;
  END IF;
END
$$;

GRANT whatchatai_tenant TO whatchatai;
GRANT USAGE ON SCHEMA public TO whatchatai_tenant;
GRANT SELECT, INSERT, UPDATE, DELETE ON whatsapp_chats, whatsapp_messages, ai_agents, crm_contacts TO whatchatai_tenant;

ALTER TABLE whatsapp_chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE whatsapp_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE crm_contacts ENABLE ROW LEVEL SECURITY;

-- NULLIF(...,'')::uuid rather than a bare cast: an unset session variable
-- reads back as '' (not NULL), and casting '' to uuid throws rather than
-- just matching nothing - the session var being unset must fail closed
-- (match zero rows), never error out a query that had no reason to expect
-- tenant scoping in the first place.
CREATE POLICY tenant_isolation ON whatsapp_chats
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON whatsapp_messages
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON ai_agents
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON crm_contacts
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
