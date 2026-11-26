PRAGMA foreign_keys = ON;

ALTER TABLE messages ADD COLUMN attachment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN stored_attachment_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE send_requests_v2 (
  key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT,
  message_id TEXT,
  message_row_id TEXT,
  -- "processing" remains accepted during the migration/deploy window for the
  -- previously deployed Worker. New code never creates it and maintenance
  -- converts any stranded compatibility rows to "unknown".
  status TEXT NOT NULL CHECK (status IN ('processing', 'reserved', 'sending', 'partial', 'complete', 'failed', 'unknown')),
  response_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_id, idempotency_key)
);

INSERT INTO send_requests_v2
  (key_id, idempotency_key, status, response_json, created_at, updated_at)
SELECT key_id, idempotency_key,
  CASE status WHEN 'complete' THEN 'complete' ELSE 'unknown' END,
  response_json, created_at, updated_at
FROM send_requests;

DROP TABLE send_requests;
ALTER TABLE send_requests_v2 RENAME TO send_requests;
CREATE INDEX send_requests_time_idx ON send_requests(created_at);
CREATE INDEX send_requests_status_time_idx ON send_requests(status, updated_at);

CREATE TABLE send_recipients (
  key_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  recipient TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('to', 'cc', 'bcc')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_message_id TEXT,
  error_message TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (key_id, idempotency_key, recipient),
  FOREIGN KEY (key_id, idempotency_key)
    REFERENCES send_requests(key_id, idempotency_key) ON DELETE CASCADE
);

CREATE INDEX send_recipients_status_idx ON send_recipients(status, updated_at);
