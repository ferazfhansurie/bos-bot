-- An installation credential creates a challenge; its account owner authorizes it.
-- Pairing, team membership, profile names and clientInstanceId confer no authority.
CREATE TABLE remote_full_challenges (
 installation_id TEXT NOT NULL REFERENCES installations(id),
 nonce TEXT NOT NULL,
 challenge TEXT NOT NULL,
 expires_at INTEGER NOT NULL,
 signer TEXT,
 owner_user_id TEXT,
 PRIMARY KEY (installation_id, nonce)
);
CREATE INDEX remote_full_expiry ON remote_full_challenges(expires_at);

-- Explicit human enrollment binds an installation to one environment.
-- Grant authorization cannot create or replace an enrollment binding.
CREATE TABLE remote_full_bindings (
 installation_id TEXT PRIMARY KEY REFERENCES installations(id),
 environment_id TEXT NOT NULL,
 server_key TEXT NOT NULL,
 audience TEXT NOT NULL,
 owner_user_id TEXT NOT NULL,
 confirmed_at INTEGER NOT NULL
);
