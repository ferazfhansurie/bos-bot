BEGIN;
-- Projected rows are invisible to the request role until an atomic cutover.
-- Accounts already authenticated by an issuer are shared; this table never
-- confers identity and only the migration owner can change authority.
CREATE TABLE cloud.migration_authority (
 workspace_id text PRIMARY KEY REFERENCES cloud.workspaces,
 state text NOT NULL CHECK(state IN ('staged','active'))
);
ALTER TABLE cloud.migration_authority ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud.migration_authority FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_scope ON cloud.migration_authority USING(workspace_id=cloud.tenant());
-- The definer must see every staged authority even when the migration role
-- has no BYPASSRLS. The request role is NOINHERIT and cannot become this owner.
DO $$ BEGIN
 EXECUTE format('CREATE POLICY migration_owner ON cloud.migration_authority TO %I USING(true) WITH CHECK(true)',current_user);
END $$;
GRANT SELECT ON cloud.migration_authority TO cloud_app;
CREATE FUNCTION cloud.migration_visible(w text) RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$
 SELECT NOT EXISTS(SELECT 1 FROM cloud.migration_authority WHERE workspace_id=w AND state='staged')
$$;
REVOKE ALL ON FUNCTION cloud.migration_visible(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud.migration_visible(text) TO cloud_app;
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='cloud'
  AND tablename NOT IN ('accounts','migration_authority') LOOP
  EXECUTE format('CREATE POLICY migration_gate ON cloud.%I AS RESTRICTIVE USING(cloud.migration_visible(workspace_id)) WITH CHECK(cloud.migration_visible(workspace_id))',t);
 END LOOP;
END $$;
CREATE OR REPLACE FUNCTION cloud.discover() RETURNS TABLE(workspace_id text,role text)
 LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$
 SELECT m.workspace_id,m.role FROM cloud.members m
 WHERE m.account_id=cloud.actor() AND cloud.migration_visible(m.workspace_id)
$$;
COMMIT;
