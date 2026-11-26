PRAGMA foreign_keys = ON;

ALTER TABLE identities ADD COLUMN display_name TEXT NOT NULL DEFAULT '';

UPDATE identities SET display_name = address WHERE display_name = '';
