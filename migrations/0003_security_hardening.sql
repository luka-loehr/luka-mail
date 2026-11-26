PRAGMA foreign_keys = ON;

ALTER TABLE api_keys ADD COLUMN allowed_identities_json TEXT;

ALTER TABLE messages ADD COLUMN identity_address TEXT;
UPDATE messages
SET identity_address = CASE
  WHEN direction = 'outbound' THEN lower(sender_address)
  ELSE lower(json_extract(recipients_json, '$[0].address'))
END;
CREATE INDEX messages_identity_folder_time_idx
  ON messages(identity_address, folder, received_at DESC, id DESC);

ALTER TABLE drafts ADD COLUMN identity_address TEXT;
CREATE INDEX drafts_identity_time_idx
  ON drafts(identity_address, updated_at DESC);
