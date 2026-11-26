PRAGMA foreign_keys = ON;

-- Every identity owns an independent, gap-free revision stream.  Payloads are
-- captured in the same SQLite transaction as the mutation so paged readers do
-- not observe a newer row state paired with an older revision.
CREATE TABLE mailbox_changes (
  identity_address TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  entity_kind TEXT NOT NULL CHECK (entity_kind IN ('message', 'draft')),
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  thread_id TEXT,
  previous_folder TEXT,
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (identity_address, revision),
  FOREIGN KEY (identity_address) REFERENCES identities(address) ON DELETE CASCADE
);

CREATE INDEX mailbox_changes_identity_entity
  ON mailbox_changes(identity_address, entity_kind, entity_id, revision DESC);
CREATE INDEX mailbox_changes_created_at ON mailbox_changes(created_at);

DROP TRIGGER messages_revision_after_insert;
CREATE TRIGGER messages_revision_after_insert
AFTER INSERT ON messages
WHEN NEW.identity_address IS NOT NULL
  AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation, thread_id, previous_folder, payload_json)
  SELECT NEW.identity_address, revision, 'message', NEW.id, 'upsert', NEW.thread_id, NULL,
    json_object('id', NEW.id, 'thread_id', NEW.thread_id, 'direction', NEW.direction, 'folder', NEW.folder,
      'subject', NEW.subject, 'sender_name', NEW.sender_name, 'sender_address', NEW.sender_address,
      'recipients_json', NEW.recipients_json, 'preview', NEW.preview, 'received_at', NEW.received_at,
      'unread', NEW.unread, 'starred', NEW.starred, 'has_attachments', NEW.has_attachments,
      'attachment_count', NEW.attachment_count, 'stored_attachment_count', NEW.stored_attachment_count, 'size', NEW.size,
      'status', NEW.status)
  FROM mailbox_revisions WHERE identity_address = NEW.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address = NEW.identity_address
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = NEW.identity_address);
END;

DROP TRIGGER messages_revision_after_update;
CREATE TRIGGER messages_revision_after_update
AFTER UPDATE ON messages
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT OLD.identity_address, 1
  WHERE OLD.identity_address IS NOT NULL AND OLD.identity_address IS NOT NEW.identity_address
    AND EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation, thread_id, previous_folder)
  SELECT OLD.identity_address, revision, 'message', OLD.id, 'delete', OLD.thread_id, OLD.folder
  FROM mailbox_revisions WHERE identity_address = OLD.identity_address
    AND OLD.identity_address IS NOT NEW.identity_address;

  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT NEW.identity_address, 1 WHERE NEW.identity_address IS NOT NULL
    AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation, thread_id, previous_folder, payload_json)
  SELECT NEW.identity_address, revision, 'message', NEW.id, 'upsert', NEW.thread_id,
    CASE WHEN OLD.identity_address IS NEW.identity_address THEN OLD.folder ELSE NULL END,
    json_object('id', NEW.id, 'thread_id', NEW.thread_id, 'direction', NEW.direction, 'folder', NEW.folder,
      'subject', NEW.subject, 'sender_name', NEW.sender_name, 'sender_address', NEW.sender_address,
      'recipients_json', NEW.recipients_json, 'preview', NEW.preview, 'received_at', NEW.received_at,
      'unread', NEW.unread, 'starred', NEW.starred, 'has_attachments', NEW.has_attachments,
      'attachment_count', NEW.attachment_count, 'stored_attachment_count', NEW.stored_attachment_count, 'size', NEW.size,
      'status', NEW.status)
  FROM mailbox_revisions WHERE identity_address = NEW.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address IN (OLD.identity_address, NEW.identity_address)
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = mailbox_changes.identity_address);
END;

DROP TRIGGER messages_revision_after_delete;
CREATE TRIGGER messages_revision_after_delete
AFTER DELETE ON messages
WHEN OLD.identity_address IS NOT NULL
  AND EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (OLD.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation, thread_id, previous_folder)
  SELECT OLD.identity_address, revision, 'message', OLD.id, 'delete', OLD.thread_id, OLD.folder
  FROM mailbox_revisions WHERE identity_address = OLD.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address = OLD.identity_address
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = OLD.identity_address);
END;

DROP TRIGGER drafts_revision_after_insert;
CREATE TRIGGER drafts_revision_after_insert
AFTER INSERT ON drafts
WHEN NEW.identity_address IS NOT NULL
  AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (NEW.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation, payload_json)
  SELECT NEW.identity_address, revision, 'draft', NEW.id, 'upsert',
    json_object('id', NEW.id, 'identity_address', NEW.identity_address, 'reply_to_message_id', NEW.reply_to_message_id,
      'recipients_json', NEW.recipients_json, 'cc_json', NEW.cc_json, 'bcc_json', NEW.bcc_json,
      'subject', NEW.subject, 'text_body', NEW.text_body, 'updated_at', NEW.updated_at)
  FROM mailbox_revisions WHERE identity_address = NEW.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address = NEW.identity_address
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = NEW.identity_address);
END;

DROP TRIGGER drafts_revision_after_update;
CREATE TRIGGER drafts_revision_after_update
AFTER UPDATE ON drafts
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT OLD.identity_address, 1
  WHERE OLD.identity_address IS NOT NULL AND OLD.identity_address IS NOT NEW.identity_address
    AND EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation)
  SELECT OLD.identity_address, revision, 'draft', OLD.id, 'delete'
  FROM mailbox_revisions WHERE identity_address = OLD.identity_address
    AND OLD.identity_address IS NOT NEW.identity_address;

  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT NEW.identity_address, 1 WHERE NEW.identity_address IS NOT NULL
    AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation, payload_json)
  SELECT NEW.identity_address, revision, 'draft', NEW.id, 'upsert',
    json_object('id', NEW.id, 'identity_address', NEW.identity_address, 'reply_to_message_id', NEW.reply_to_message_id,
      'recipients_json', NEW.recipients_json, 'cc_json', NEW.cc_json, 'bcc_json', NEW.bcc_json,
      'subject', NEW.subject, 'text_body', NEW.text_body, 'updated_at', NEW.updated_at)
  FROM mailbox_revisions WHERE identity_address = NEW.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address IN (OLD.identity_address, NEW.identity_address)
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = mailbox_changes.identity_address);
END;

DROP TRIGGER drafts_revision_after_delete;
CREATE TRIGGER drafts_revision_after_delete
AFTER DELETE ON drafts
WHEN OLD.identity_address IS NOT NULL
  AND EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision) VALUES (OLD.identity_address, 1)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
  INSERT INTO mailbox_changes (identity_address, revision, entity_kind, entity_id, operation)
  SELECT OLD.identity_address, revision, 'draft', OLD.id, 'delete'
  FROM mailbox_revisions WHERE identity_address = OLD.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address = OLD.identity_address
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = OLD.identity_address);
END;
