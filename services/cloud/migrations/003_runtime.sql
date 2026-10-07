BEGIN;
CREATE TABLE cloud.bots (
 workspace_id text NOT NULL REFERENCES cloud.workspaces, bot_id text NOT NULL, owner_id text NOT NULL REFERENCES cloud.accounts,
 name text NOT NULL, model jsonb NOT NULL, PRIMARY KEY(workspace_id,bot_id)
);
CREATE TABLE cloud.bot_rooms (
 workspace_id text NOT NULL, bot_id text NOT NULL, room_id text NOT NULL,
 PRIMARY KEY(workspace_id,bot_id,room_id), FOREIGN KEY(workspace_id,bot_id) REFERENCES cloud.bots,
 FOREIGN KEY(workspace_id,room_id) REFERENCES cloud.rooms
);
CREATE TABLE cloud.hosts (
 workspace_id text NOT NULL REFERENCES cloud.workspaces, host_id text NOT NULL, owner_id text NOT NULL REFERENCES cloud.accounts,
 name text NOT NULL, bot_ids jsonb NOT NULL, credential_hash text NOT NULL, expires_at timestamptz NOT NULL,
 revoked boolean NOT NULL DEFAULT false, online boolean NOT NULL DEFAULT true, last_seen timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(workspace_id,host_id)
);
CREATE TABLE cloud.invocations (
 workspace_id text NOT NULL, room_id text NOT NULL, thread_id text NOT NULL, invocation_id text NOT NULL,
 bot_id text NOT NULL, source_message_id text NOT NULL, source_actor_id text NOT NULL REFERENCES cloud.accounts,
 source json NOT NULL, model jsonb NOT NULL, state text NOT NULL CHECK(state IN ('queued','leased','running','waiting_for_human','held','completed','failed','cancelled')),
 attempt integer NOT NULL DEFAULT 0, fence_gen bigint NOT NULL DEFAULT 0, control_revision bigint NOT NULL DEFAULT 0,
 host_id text, lease_expires_at timestamptz, queued_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 result_message_id text, stop_requested boolean NOT NULL DEFAULT false, stopped_observed boolean NOT NULL DEFAULT false,
 replay_safe boolean NOT NULL DEFAULT true, streamed_bytes bigint NOT NULL DEFAULT 0, delta_count integer NOT NULL DEFAULT 0, PRIMARY KEY(workspace_id,invocation_id),
 UNIQUE(workspace_id,source_message_id,bot_id), UNIQUE(workspace_id,result_message_id),
 FOREIGN KEY(workspace_id,room_id,thread_id,source_message_id) REFERENCES cloud.messages(workspace_id,room_id,thread_id,message_id),
 FOREIGN KEY(workspace_id,bot_id) REFERENCES cloud.bots, FOREIGN KEY(workspace_id,host_id) REFERENCES cloud.hosts,
 FOREIGN KEY(workspace_id,room_id,result_message_id) REFERENCES cloud.messages(workspace_id,room_id,message_id)
);
CREATE TABLE cloud.run_attempts (
 workspace_id text NOT NULL, invocation_id text NOT NULL, attempt integer NOT NULL, fence_gen bigint NOT NULL,
 host_id text NOT NULL, model jsonb NOT NULL, started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,invocation_id,attempt), FOREIGN KEY(workspace_id,invocation_id) REFERENCES cloud.invocations
);
CREATE TABLE cloud.run_events (
 workspace_id text NOT NULL, invocation_id text NOT NULL, attempt integer NOT NULL, fence_gen bigint NOT NULL,
 event_key text NOT NULL, digest text NOT NULL, PRIMARY KEY(workspace_id,invocation_id,attempt,event_key),
 FOREIGN KEY(workspace_id,invocation_id,attempt) REFERENCES cloud.run_attempts
);
CREATE TABLE cloud.approvals (
 workspace_id text NOT NULL, room_id text NOT NULL, thread_id text NOT NULL, invocation_id text NOT NULL,
 approval_id text NOT NULL, actor_id text NOT NULL REFERENCES cloud.accounts, attempt integer NOT NULL, fence_gen bigint NOT NULL,
 version integer NOT NULL DEFAULT 1, effect_id text NOT NULL, digest text NOT NULL, title text NOT NULL,
 expires_at timestamptz NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied','expired','revoked')),
 PRIMARY KEY(workspace_id,approval_id), UNIQUE(workspace_id,invocation_id,effect_id),
 FOREIGN KEY(workspace_id,invocation_id) REFERENCES cloud.invocations,
 FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads
);
CREATE TABLE cloud.attachment_objects (
 workspace_id text NOT NULL, room_id text NOT NULL, thread_id text NOT NULL, attachment_id text NOT NULL,
 owner_id text NOT NULL REFERENCES cloud.accounts, object_key text NOT NULL UNIQUE, name text NOT NULL,
 size bigint NOT NULL CHECK(size>0 AND size<=10485760), type text NOT NULL, checksum text NOT NULL,
 state text NOT NULL CHECK(state IN ('preparing','uploading','verifying','ready','rejected','expired')),
 expires_at timestamptz NOT NULL, upload_expires_at timestamptz NOT NULL, attached boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,attachment_id), FOREIGN KEY(workspace_id,room_id,thread_id) REFERENCES cloud.threads
);
CREATE TABLE cloud.message_attachments (
 workspace_id text NOT NULL, room_id text NOT NULL, message_id text NOT NULL, attachment_id text NOT NULL,
 PRIMARY KEY(workspace_id,message_id,attachment_id), FOREIGN KEY(workspace_id,room_id,message_id) REFERENCES cloud.messages,
 FOREIGN KEY(workspace_id,attachment_id) REFERENCES cloud.attachment_objects
);
ALTER TABLE cloud.messages ADD COLUMN bot_id text;
ALTER TABLE cloud.messages ADD COLUMN attachment_ids jsonb NOT NULL DEFAULT '[]';
CREATE TABLE cloud.push_registrations (
 workspace_id text NOT NULL, registration_id text NOT NULL, account_id text NOT NULL REFERENCES cloud.accounts,
 session_hash text NOT NULL, installation_id text NOT NULL, generation bigint NOT NULL, token_version bigint NOT NULL,
 provider text NOT NULL CHECK(provider='apns'), environment text NOT NULL CHECK(environment='sandbox'),
 expires_at timestamptz NOT NULL, revoked boolean NOT NULL DEFAULT false, muted boolean NOT NULL DEFAULT false, mentions_only boolean NOT NULL DEFAULT false,
 PRIMARY KEY(workspace_id,registration_id), FOREIGN KEY(workspace_id) REFERENCES cloud.workspaces
);
CREATE TABLE cloud.push_hints (
 workspace_id text NOT NULL, registration_id text NOT NULL, room_id text NOT NULL, event_id text NOT NULL, payload jsonb NOT NULL, account_id text NOT NULL REFERENCES cloud.accounts, installation_id text NOT NULL,
 PRIMARY KEY(workspace_id,registration_id,event_id), UNIQUE(workspace_id,account_id,installation_id,event_id), FOREIGN KEY(workspace_id,registration_id) REFERENCES cloud.push_registrations,
 FOREIGN KEY(workspace_id,room_id,event_id) REFERENCES cloud.room_events
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['bots','bot_rooms','hosts','invocations','run_attempts','run_events','approvals','attachment_objects','message_attachments','push_registrations','push_hints'] LOOP
  EXECUTE format('ALTER TABLE cloud.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE cloud.%I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_scope ON cloud.%I USING(workspace_id=cloud.tenant()) WITH CHECK(workspace_id=cloud.tenant())',t);
  EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON cloud.%I TO cloud_app',t);
 END LOOP;
END $$;
CREATE POLICY private_actor ON cloud.push_registrations AS RESTRICTIVE USING(account_id=cloud.actor()) WITH CHECK(account_id=cloud.actor());
CREATE POLICY private_actor ON cloud.push_hints AS RESTRICTIVE USING(account_id=cloud.actor()) WITH CHECK(account_id=cloud.actor());
CREATE OR REPLACE FUNCTION cloud.pending_workspaces() RETURNS SETOF text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,cloud AS $$
 SELECT workspace_id FROM cloud.work_queue WHERE completed_at IS NULL
 UNION SELECT workspace_id FROM cloud.invocations WHERE state IN ('queued','leased','running','waiting_for_human')
 UNION SELECT workspace_id FROM cloud.hosts WHERE online
 UNION SELECT workspace_id FROM cloud.attachment_objects WHERE NOT attached AND state<>'expired'
$$;
COMMIT;
