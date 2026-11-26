PRAGMA foreign_keys = ON;

CREATE TABLE send_requests (
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'complete')),
  response_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_id, idempotency_key)
);

CREATE INDEX send_requests_time_idx ON send_requests(created_at);
