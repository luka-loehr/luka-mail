PRAGMA foreign_keys = ON;

-- A monotonic, identity-scoped revision makes change detection constant-size and
-- cannot miss multiple mutations that happen inside the same clock second.
CREATE TABLE mailbox_revisions (
  identity_address TEXT PRIMARY KEY REFERENCES identities(address) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO mailbox_revisions (identity_address, revision)
SELECT address, 1 FROM identities;

CREATE TRIGGER messages_revision_after_insert
AFTER INSERT ON messages
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER messages_revision_after_update
AFTER UPDATE ON messages
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER messages_revision_after_delete
AFTER DELETE ON messages
WHEN OLD.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (OLD.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER drafts_revision_after_insert
AFTER INSERT ON drafts
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER drafts_revision_after_update
AFTER UPDATE ON drafts
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER drafts_revision_after_delete
AFTER DELETE ON drafts
WHEN OLD.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (OLD.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;
