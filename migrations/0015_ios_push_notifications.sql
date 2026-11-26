PRAGMA foreign_keys = ON;

CREATE TABLE push_devices (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  device_token TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('development', 'production')),
  identities_json TEXT NOT NULL CHECK (json_valid(identities_json) AND json_type(identities_json) = 'array'),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  disabled_at TEXT,
  last_success_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (device_token, environment),
  FOREIGN KEY (key_id) REFERENCES api_keys(id) ON DELETE CASCADE
);

CREATE INDEX push_devices_active_identity ON push_devices(disabled_at, environment);

-- This durable handoff closes the commit/enqueue race: a message becoming
-- visible and its pending notification are one SQLite transaction. Queue
-- retries can safely resume the outbox after crashes or transient APNs errors.
CREATE TABLE push_notification_outbox (
  message_id TEXT PRIMARY KEY,
  identity_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX push_notification_outbox_pending
  ON push_notification_outbox(status, updated_at, created_at);

CREATE TRIGGER push_outbox_messages_after_insert
AFTER INSERT ON messages
WHEN NEW.direction = 'inbound' AND NEW.status = 'ready' AND NEW.identity_address IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO push_notification_outbox (message_id, identity_address)
  VALUES (NEW.id, NEW.identity_address);
END;

CREATE TRIGGER push_outbox_messages_after_ready
AFTER UPDATE OF status ON messages
WHEN NEW.direction = 'inbound' AND NEW.status = 'ready' AND OLD.status IS NOT 'ready'
  AND NEW.identity_address IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO push_notification_outbox (message_id, identity_address)
  VALUES (NEW.id, NEW.identity_address);
END;
