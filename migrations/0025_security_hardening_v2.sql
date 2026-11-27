PRAGMA foreign_keys = ON;

-- Remove unused rate-limit table superseded by Cloudflare Rate Limiting bindings
-- and drop unused mailbox_changes timestamp index.
DROP TABLE IF EXISTS api_rate_limits;
DROP INDEX IF EXISTS mailbox_changes_created_at;

-- Scope Message-ID uniqueness per mailbox identity rather than globally so a
-- message delivered or synced to multiple mailboxes is never dropped or stripped.
DROP INDEX IF EXISTS messages_message_id_idx;
CREATE UNIQUE INDEX messages_identity_message_id_idx
  ON messages(identity_address, message_id)
  WHERE message_id IS NOT NULL;

-- Bind APNs push registrations to the specific native passkey session that
-- registered them so session logout, revocation, or expiry stops lock-screen alerts.
ALTER TABLE push_devices
  ADD COLUMN native_session_hash TEXT REFERENCES native_sessions(token_hash) ON DELETE CASCADE;

CREATE INDEX push_devices_native_session_idx
  ON push_devices(native_session_hash)
  WHERE native_session_hash IS NOT NULL;

-- Include spam and triage metadata in mailbox_changes payloads so incremental
-- /v1/mailbox-delta sync never delivers spam into live client inboxes, and skip
-- internal-only metadata updates (sender_authenticated, drafted_at, spam_checked_at).
DROP TRIGGER IF EXISTS messages_revision_after_insert;
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
      'status', NEW.status, 'spam', NEW.spam, 'triage_category', NEW.triage_category,
      'triage_confidence', NEW.triage_confidence, 'triage_needs_reply', NEW.triage_needs_reply,
      'triage_urgency', NEW.triage_urgency)
  FROM mailbox_revisions WHERE identity_address = NEW.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address = NEW.identity_address
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = NEW.identity_address);
END;

DROP TRIGGER IF EXISTS messages_revision_after_update;
CREATE TRIGGER messages_revision_after_update
AFTER UPDATE ON messages
WHEN OLD.identity_address IS NOT NEW.identity_address
  OR OLD.thread_id IS NOT NEW.thread_id
  OR OLD.direction IS NOT NEW.direction
  OR OLD.folder IS NOT NEW.folder
  OR OLD.subject IS NOT NEW.subject
  OR OLD.sender_name IS NOT NEW.sender_name
  OR OLD.sender_address IS NOT NEW.sender_address
  OR OLD.recipients_json IS NOT NEW.recipients_json
  OR OLD.preview IS NOT NEW.preview
  OR OLD.received_at IS NOT NEW.received_at
  OR OLD.unread IS NOT NEW.unread
  OR OLD.starred IS NOT NEW.starred
  OR OLD.has_attachments IS NOT NEW.has_attachments
  OR OLD.attachment_count IS NOT NEW.attachment_count
  OR OLD.stored_attachment_count IS NOT NEW.stored_attachment_count
  OR OLD.size IS NOT NEW.size
  OR OLD.status IS NOT NEW.status
  OR OLD.spam IS NOT NEW.spam
  OR OLD.triage_category IS NOT NEW.triage_category
  OR OLD.triage_confidence IS NOT NEW.triage_confidence
  OR OLD.triage_needs_reply IS NOT NEW.triage_needs_reply
  OR OLD.triage_urgency IS NOT NEW.triage_urgency
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
      'status', NEW.status, 'spam', NEW.spam, 'triage_category', NEW.triage_category,
      'triage_confidence', NEW.triage_confidence, 'triage_needs_reply', NEW.triage_needs_reply,
      'triage_urgency', NEW.triage_urgency)
  FROM mailbox_revisions WHERE identity_address = NEW.identity_address;
  DELETE FROM mailbox_changes WHERE identity_address IN (OLD.identity_address, NEW.identity_address)
    AND revision <= (SELECT revision - 10000 FROM mailbox_revisions WHERE identity_address = mailbox_changes.identity_address);
END;
