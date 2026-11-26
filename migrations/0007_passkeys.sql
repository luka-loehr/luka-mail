PRAGMA foreign_keys = ON;

CREATE TABLE webauthn_credentials (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  webauthn_user_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  device_type TEXT NOT NULL,
  backed_up INTEGER NOT NULL DEFAULT 0 CHECK (backed_up IN (0, 1)),
  transports_json TEXT NOT NULL DEFAULT '[]',
  name TEXT NOT NULL DEFAULT 'Passkey',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at TEXT
);

CREATE INDEX webauthn_credentials_key_idx ON webauthn_credentials(key_id);

CREATE TABLE webauthn_challenges (
  id TEXT PRIMARY KEY,
  challenge TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
  key_id TEXT REFERENCES api_keys(id) ON DELETE CASCADE,
  webauthn_user_id TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX webauthn_challenges_expiry_idx ON webauthn_challenges(expires_at);

CREATE TABLE web_sessions (
  token_hash TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES webauthn_credentials(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX web_sessions_expiry_idx ON web_sessions(expires_at);
CREATE INDEX web_sessions_key_idx ON web_sessions(key_id);
