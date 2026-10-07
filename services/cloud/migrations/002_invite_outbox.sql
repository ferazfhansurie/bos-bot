BEGIN;
-- Transactional publication receipt; never stores the invitation bearer/token.
CREATE TABLE cloud.invite_outbox(
  workspace_id text NOT NULL,
  invite_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  publication_state text NOT NULL CHECK(publication_state IN ('pending','published')),
  PRIMARY KEY(workspace_id,invite_id),
  FOREIGN KEY(workspace_id,invite_id) REFERENCES cloud.invites ON DELETE CASCADE
);
ALTER TABLE cloud.invite_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud.invite_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON cloud.invite_outbox USING(workspace_id=cloud.tenant()) WITH CHECK(workspace_id=cloud.tenant());
GRANT SELECT,INSERT,UPDATE,DELETE ON cloud.invite_outbox TO cloud_app;
CREATE FUNCTION cloud.pending_invite_publications() RETURNS TABLE(workspace_id text,invite_id text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$ SELECT workspace_id,invite_id FROM cloud.invite_outbox WHERE publication_state='pending' AND created_at < clock_timestamp()-interval '15 seconds' $$;
REVOKE ALL ON FUNCTION cloud.pending_invite_publications() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud.pending_invite_publications() TO cloud_app;
-- Existing slice-1 invitations were already returned to callers.
INSERT INTO cloud.invite_outbox(workspace_id,invite_id,publication_state) SELECT workspace_id,invite_id,'published' FROM cloud.invites;
COMMIT;
