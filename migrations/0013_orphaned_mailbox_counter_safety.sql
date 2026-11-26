PRAGMA foreign_keys = ON;

-- Identities may be disabled/deleted while their historical messages remain.
-- Updating one of those preserved rows must not try to recreate a counter row
-- whose identity foreign key no longer exists. Re-enabling the address still
-- rebuilds its counters through mailbox_counts_identities_after_insert.
DROP TRIGGER mailbox_counts_messages_after_insert;
CREATE TRIGGER mailbox_counts_messages_after_insert
AFTER INSERT ON messages
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash)
  SELECT NEW.identity_address,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.unread = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'sent' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.starred = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'archive' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'trash' THEN 1 ELSE 0 END
  WHERE EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET
    unread = unread + excluded.unread, inbox = inbox + excluded.inbox,
    sent = sent + excluded.sent, starred = starred + excluded.starred,
    archive = archive + excluded.archive, trash = trash + excluded.trash,
    updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER mailbox_counts_messages_after_update;
CREATE TRIGGER mailbox_counts_messages_after_update
AFTER UPDATE OF identity_address, status, folder, unread, starred ON messages
WHEN OLD.identity_address IS NOT NEW.identity_address
  OR OLD.status IS NOT NEW.status
  OR OLD.folder IS NOT NEW.folder
  OR OLD.unread IS NOT NEW.unread
  OR OLD.starred IS NOT NEW.starred
BEGIN
  UPDATE mailbox_counts SET
    unread = unread - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' AND OLD.unread = 1 THEN 1 ELSE 0 END,
    inbox = inbox - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'inbox' THEN 1 ELSE 0 END,
    sent = sent - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'sent' THEN 1 ELSE 0 END,
    starred = starred - CASE WHEN OLD.status = 'ready' AND OLD.starred = 1 AND OLD.folder != 'trash' THEN 1 ELSE 0 END,
    archive = archive - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'archive' THEN 1 ELSE 0 END,
    trash = trash - CASE WHEN OLD.status = 'ready' AND OLD.folder = 'trash' THEN 1 ELSE 0 END,
    updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;

  INSERT INTO mailbox_counts (identity_address, unread, inbox, sent, starred, archive, trash)
  SELECT NEW.identity_address,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' AND NEW.unread = 1 THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'inbox' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'sent' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.starred = 1 AND NEW.folder != 'trash' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'archive' THEN 1 ELSE 0 END,
    CASE WHEN NEW.status = 'ready' AND NEW.folder = 'trash' THEN 1 ELSE 0 END
  WHERE NEW.identity_address IS NOT NULL
    AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET
    unread = unread + excluded.unread, inbox = inbox + excluded.inbox,
    sent = sent + excluded.sent, starred = starred + excluded.starred,
    archive = archive + excluded.archive, trash = trash + excluded.trash,
    updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER mailbox_counts_drafts_after_insert;
CREATE TRIGGER mailbox_counts_drafts_after_insert
AFTER INSERT ON drafts
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_counts (identity_address, drafts)
  SELECT NEW.identity_address, 1
  WHERE EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET drafts = drafts + 1, updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER mailbox_counts_drafts_after_update;
CREATE TRIGGER mailbox_counts_drafts_after_update
AFTER UPDATE OF identity_address ON drafts
WHEN OLD.identity_address IS NOT NEW.identity_address
BEGIN
  UPDATE mailbox_counts SET drafts = drafts - 1, updated_at = CURRENT_TIMESTAMP
  WHERE identity_address = OLD.identity_address;

  INSERT INTO mailbox_counts (identity_address, drafts)
  SELECT NEW.identity_address, 1
  WHERE NEW.identity_address IS NOT NULL
    AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET drafts = drafts + 1, updated_at = CURRENT_TIMESTAMP;
END;

-- Mailbox revisions carry the same identity foreign key. Make all revision
-- triggers tolerate preserved mail whose identity is temporarily absent.
DROP TRIGGER messages_revision_after_insert;
CREATE TRIGGER messages_revision_after_insert
AFTER INSERT ON messages
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT NEW.identity_address, 1
  WHERE EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER messages_revision_after_update;
CREATE TRIGGER messages_revision_after_update
AFTER UPDATE ON messages
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT OLD.identity_address, 1
  WHERE OLD.identity_address IS NOT NULL
    AND OLD.identity_address IS NOT NEW.identity_address
    AND EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT NEW.identity_address, 1
  WHERE NEW.identity_address IS NOT NULL
    AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER messages_revision_after_delete;
CREATE TRIGGER messages_revision_after_delete
AFTER DELETE ON messages
WHEN OLD.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT OLD.identity_address, 1
  WHERE EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER drafts_revision_after_insert;
CREATE TRIGGER drafts_revision_after_insert
AFTER INSERT ON drafts
WHEN NEW.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT NEW.identity_address, 1
  WHERE EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER drafts_revision_after_update;
CREATE TRIGGER drafts_revision_after_update
AFTER UPDATE ON drafts
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT OLD.identity_address, 1
  WHERE OLD.identity_address IS NOT NULL
    AND OLD.identity_address IS NOT NEW.identity_address
    AND EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;

  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT NEW.identity_address, 1
  WHERE NEW.identity_address IS NOT NULL
    AND EXISTS (SELECT 1 FROM identities WHERE address = NEW.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;

DROP TRIGGER drafts_revision_after_delete;
CREATE TRIGGER drafts_revision_after_delete
AFTER DELETE ON drafts
WHEN OLD.identity_address IS NOT NULL
BEGIN
  INSERT INTO mailbox_revisions (identity_address, revision)
  SELECT OLD.identity_address, 1
  WHERE EXISTS (SELECT 1 FROM identities WHERE address = OLD.identity_address)
  ON CONFLICT(identity_address) DO UPDATE SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP;
END;
