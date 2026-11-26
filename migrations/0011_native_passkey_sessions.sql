PRAGMA foreign_keys = ON;

ALTER TABLE webauthn_credentials
  ADD COLUMN assertion_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE native_authorization_requests (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  state TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'macos')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX native_authorization_requests_expiry_idx
  ON native_authorization_requests(expires_at);

CREATE TABLE native_authorization_codes (
  code_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES webauthn_credentials(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX native_authorization_codes_expiry_idx
  ON native_authorization_codes(expires_at);

CREATE TABLE native_sessions (
  token_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES webauthn_credentials(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  scopes_json TEXT NOT NULL,
  allowed_identities_json TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX native_sessions_expiry_idx ON native_sessions(expires_at);
CREATE INDEX native_sessions_key_idx ON native_sessions(key_id);
