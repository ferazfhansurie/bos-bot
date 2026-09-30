-- Fail migration on existing conflicting ownership, never pick a winner or
-- silently transfer. Deployment must resolve any legacy conflicts explicitly.
CREATE UNIQUE INDEX remote_full_environment_owner ON remote_full_bindings(environment_id);
ALTER TABLE remote_full_bindings ADD COLUMN explicitly_enrolled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE remote_full_challenges ADD COLUMN credential_lookup TEXT;
-- Pre-upgrade challenges lack credential proof and must be reconfirmed.
DELETE FROM remote_full_challenges;

-- Provisioned only by the reviewed control-plane operator enrollment process.
-- No public/account/paired/loopback endpoint can issue or replace a permit.
-- A human owner verifies the on-host public enrollment scope; an independent
-- CP operator verifies installation ownership before reserving the environment.
CREATE TABLE remote_full_enrollment_permits (
 environment_id TEXT PRIMARY KEY,
 installation_id TEXT NOT NULL UNIQUE REFERENCES installations(id),
 owner_user_id TEXT NOT NULL,
 server_key TEXT NOT NULL,
 audience TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
