-- customer_memory (migration 959) was created after migration 958's RLS
-- extension to every other real tenant table, so it missed that same
-- backstop. Same pattern as 944/958: the app's own login role
-- (whatchatai) is a superuser and always bypasses RLS - this is a backstop
-- for code that explicitly opts in via db/pool.ts's queryAsTenant(), not a
-- blanket enforcement of the main query path.
GRANT SELECT, INSERT, UPDATE, DELETE ON customer_memory TO whatchatai_tenant;

ALTER TABLE customer_memory ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customer_memory
  USING (business_id = NULLIF(current_setting('app.current_business_id', true), '')::uuid);
