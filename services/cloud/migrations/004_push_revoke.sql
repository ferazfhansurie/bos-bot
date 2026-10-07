-- member removal runs as the removing admin, so the private_actor policy hides the removed account's push rows.
CREATE FUNCTION cloud.revoke_member_push(w text, a text) RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$
  UPDATE cloud.push_registrations SET revoked=true WHERE workspace_id=w AND account_id=a AND NOT EXISTS(SELECT 1 FROM cloud.members m WHERE m.workspace_id=w AND m.account_id=a) $$;
REVOKE ALL ON FUNCTION cloud.revoke_member_push(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cloud.revoke_member_push(text,text) TO cloud_app;
