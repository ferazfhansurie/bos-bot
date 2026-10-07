-- Local slice only. Run as migration owner, never as the request role.
BEGIN;
CREATE ROLE cloud_app LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE SCHEMA cloud;
CREATE TABLE cloud.accounts(
  account_id text PRIMARY KEY,
  issuer text NOT NULL,
  subject text NOT NULL,
  UNIQUE(issuer,subject)
);
CREATE TABLE cloud.workspaces(
  workspace_id text PRIMARY KEY,
  name text NOT NULL,
  epoch text NOT NULL
);
CREATE TABLE cloud.members(
  workspace_id text NOT NULL REFERENCES cloud.workspaces,
  account_id text NOT NULL REFERENCES cloud.accounts,
  role text NOT NULL CHECK(role IN ('owner','admin','member','guest')),
  PRIMARY KEY(workspace_id,account_id)
);
CREATE TABLE cloud.rooms(
  workspace_id text NOT NULL REFERENCES cloud.workspaces,
  room_id text NOT NULL,
  name text NOT NULL,
  policy_revision bigint NOT NULL DEFAULT 1,
  head bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,room_id)
);
CREATE TABLE cloud.threads(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  thread_id text NOT NULL,
  archived boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,room_id,thread_id),
  FOREIGN KEY(workspace_id,room_id) REFERENCES cloud.rooms
);
CREATE TABLE cloud.room_grants(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  account_id text NOT NULL,
  PRIMARY KEY(workspace_id,room_id,account_id),
  FOREIGN KEY(workspace_id,room_id) REFERENCES cloud.rooms,
  FOREIGN KEY(workspace_id,account_id) REFERENCES cloud.members ON DELETE CASCADE
);
CREATE TABLE cloud.invites(
  workspace_id text NOT NULL REFERENCES cloud.workspaces,
  invite_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  inviter_id text NOT NULL REFERENCES cloud.accounts,
  role text NOT NULL CHECK(role IN ('owner','admin','member','guest')),
  subject text,
  expires_at timestamptz NOT NULL,
  revoked boolean NOT NULL DEFAULT false,
  redeemed_by text REFERENCES cloud.accounts,
  PRIMARY KEY(workspace_id,invite_id)
);
CREATE TABLE cloud.invite_rooms(
  workspace_id text NOT NULL,
  invite_id text NOT NULL,
  room_id text NOT NULL,
  PRIMARY KEY(workspace_id,invite_id,room_id),
  FOREIGN KEY(workspace_id,invite_id) REFERENCES cloud.invites,
  FOREIGN KEY(workspace_id,room_id) REFERENCES cloud.rooms
);
CREATE TABLE cloud.windows(
  workspace_id text NOT NULL,
  account_id text NOT NULL REFERENCES cloud.accounts,
  window_id text NOT NULL,
  epoch text NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,window_id),
  FOREIGN KEY(workspace_id) REFERENCES cloud.workspaces
);
-- Exact JSON source strings preserve NUL and unpaired UTF-16 escapes without normalization.
-- jsonb/text would reject these frozen-envelope strings. No SQL extraction/cast to text.
CREATE TABLE cloud.messages(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  thread_id text NOT NULL,
  message_id text NOT NULL,
  actor_id text NOT NULL REFERENCES cloud.accounts,
  client_operation_id text NOT NULL,
  sequence bigint NOT NULL,
  version integer NOT NULL DEFAULT 1,
  text json NOT NULL CHECK(json_typeof(text)='string'),
  mentions jsonb NOT NULL,
  reply_to_message_id text,
  deleted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,room_id,message_id),
  UNIQUE(workspace_id,room_id,sequence),
  UNIQUE(workspace_id,room_id,thread_id,message_id),
  FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads,
  FOREIGN KEY(workspace_id,room_id,thread_id,reply_to_message_id) REFERENCES cloud.messages(workspace_id,room_id,thread_id,message_id)
);
CREATE TABLE cloud.operations(
  workspace_id text NOT NULL,
  account_id text NOT NULL REFERENCES cloud.accounts,
  client_operation_id text NOT NULL,
  digest text NOT NULL,
  room_id text NOT NULL,
  thread_id text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(workspace_id,account_id,client_operation_id),
  FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads
);
CREATE TABLE cloud.room_events(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  event_id text NOT NULL,
  sequence bigint NOT NULL,
  thread_id text,
  kind text NOT NULL,
  payload json NOT NULL,
  PRIMARY KEY(workspace_id,room_id,event_id),
  UNIQUE(workspace_id,room_id,sequence),
  FOREIGN KEY(workspace_id,room_id) REFERENCES cloud.rooms,
  FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads
);
CREATE TABLE cloud.outbox(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  event_id text NOT NULL,
  PRIMARY KEY(workspace_id,room_id,event_id),
  FOREIGN KEY(workspace_id,room_id,event_id) REFERENCES cloud.room_events
);
CREATE TABLE cloud.work_queue(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  event_id text NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  completed_at timestamptz,
  PRIMARY KEY(workspace_id,room_id,event_id),
  FOREIGN KEY(workspace_id,room_id,event_id) REFERENCES cloud.outbox
);
CREATE TABLE cloud.snapshots(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  thread_id text NOT NULL,
  snapshot_id text NOT NULL,
  account_id text NOT NULL REFERENCES cloud.accounts,
  epoch text NOT NULL,
  policy_revision bigint NOT NULL,
  watermark bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  projection json NOT NULL,
  PRIMARY KEY(workspace_id,room_id,snapshot_id),
  FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads
);
CREATE TABLE cloud.read_coverage(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  thread_id text NOT NULL,
  account_id text NOT NULL REFERENCES cloud.accounts,
  prefix bigint NOT NULL DEFAULT 0,
  intervals jsonb NOT NULL DEFAULT '[]',
  attention boolean NOT NULL DEFAULT false,
  PRIMARY KEY(workspace_id,room_id,thread_id,account_id),
  FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads
);
-- Acknowledged watermark is private and advances only when a snapshot/batch is admitted.
CREATE TABLE cloud.read_heads(
  workspace_id text NOT NULL,
  room_id text NOT NULL,
  thread_id text NOT NULL,
  account_id text NOT NULL REFERENCES cloud.accounts,
  head bigint NOT NULL DEFAULT 0,
  PRIMARY KEY(workspace_id,room_id,thread_id,account_id),
  FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads
);
CREATE FUNCTION cloud.actor() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cloud.account_id',true),'') $$;
CREATE FUNCTION cloud.tenant() RETURNS text LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('cloud.workspace_id',true),'') $$;
DO $$ DECLARE t text; BEGIN
 FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='cloud' AND tablename<>'accounts' LOOP
  EXECUTE format('ALTER TABLE cloud.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE cloud.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON cloud.%I USING (workspace_id = cloud.tenant()) WITH CHECK (workspace_id = cloud.tenant())',t);
 END LOOP;
END $$;
-- Tenant policy AND private actor policy. No client can request somebody else's read/receipt.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['operations','windows','snapshots','read_coverage','read_heads'] LOOP
  EXECUTE format('CREATE POLICY private_actor ON cloud.%I AS RESTRICTIVE USING (account_id = cloud.actor()) WITH CHECK (account_id = cloud.actor())',t);
 END LOOP;
END $$;
ALTER TABLE cloud.accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_self ON cloud.accounts USING(account_id=cloud.actor()) WITH CHECK(account_id=cloud.actor());
-- These narrowly scoped bootstrap helpers run as the migration role. No arbitrary SQL or payload.
CREATE FUNCTION cloud.ensure_account(a text,i text,s text) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$ DECLARE found text; BEGIN
 INSERT INTO cloud.accounts VALUES(a,i,s) ON CONFLICT(issuer,subject) DO NOTHING;
 SELECT account_id INTO found FROM cloud.accounts WHERE issuer=i AND subject=s;
 RETURN found;
END $$;
CREATE FUNCTION cloud.discover() RETURNS TABLE(workspace_id text,role text) LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$ SELECT m.workspace_id,m.role FROM cloud.members m WHERE m.account_id=cloud.actor() $$;
CREATE FUNCTION cloud.locate_invite(h text) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$ SELECT workspace_id FROM cloud.invites WHERE token_hash=h $$;
-- Worker polls durable rows; the definer returns only tenant identifiers, never room payload.
CREATE FUNCTION cloud.pending_workspaces() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$ SELECT DISTINCT workspace_id FROM cloud.work_queue WHERE completed_at IS NULL $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cloud FROM PUBLIC;
GRANT USAGE ON SCHEMA cloud TO cloud_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA cloud TO cloud_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cloud TO cloud_app;
COMMIT;
