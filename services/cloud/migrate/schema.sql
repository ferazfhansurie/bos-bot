-- Operator-only inert import ledger. No application grant, policy, queue or trigger.
CREATE SCHEMA IF NOT EXISTS migration;
REVOKE ALL ON SCHEMA migration FROM PUBLIC;
CREATE TABLE IF NOT EXISTS migration.migration_runs (
 workspace_id text PRIMARY KEY, source_install_id text NOT NULL, source_digest text NOT NULL,
 state text NOT NULL CHECK(state IN ('inventoried','frozen','imported','validated','cloud_active','legacy_archived','failed','held')),
 epoch bigint NOT NULL DEFAULT 1, checkpoint bigint NOT NULL DEFAULT 0,
 projection_verified boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS migration.migration_mappings (
 workspace_id text NOT NULL REFERENCES migration.migration_runs ON DELETE CASCADE,
 source_install_id text NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
 cloud_id uuid NOT NULL, digest text NOT NULL,
 PRIMARY KEY(workspace_id,source_type,source_id), UNIQUE(source_install_id,source_type,source_id)
);
CREATE TABLE IF NOT EXISTS migration.legacy_records (
 workspace_id text NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
 payload json NOT NULL, provenance jsonb NOT NULL, trigger_policy text NOT NULL CHECK(trigger_policy='none'),
 PRIMARY KEY(workspace_id,source_type,source_id),
 FOREIGN KEY(workspace_id,source_type,source_id) REFERENCES migration.migration_mappings ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS migration.migration_quarantine (
 workspace_id text NOT NULL, source_type text NOT NULL, source_id text NOT NULL, reason text NOT NULL,
 PRIMARY KEY(workspace_id,source_type,source_id),
 FOREIGN KEY(workspace_id,source_type,source_id) REFERENCES migration.migration_mappings ON DELETE CASCADE
);
