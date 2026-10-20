-- A desktop can register itself with no email: the control plane creates an
-- owner that exists only for that one installation. This table marks those
-- owners so the total can be capped and they can never pass for a person.
CREATE TABLE installation_owned_accounts (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Registration is unauthenticated, so it is limited per caller IP (an HMAC,
-- never the address) and globally. One row per key and fixed window.
CREATE TABLE installation_registration_limits (
  limit_key TEXT PRIMARY KEY CHECK (length(limit_key) = 64),
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1),
  updated_at INTEGER NOT NULL
);

CREATE INDEX installation_registration_limits_updated_idx
  ON installation_registration_limits(updated_at);
