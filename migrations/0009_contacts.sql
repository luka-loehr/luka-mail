PRAGMA foreign_keys = ON;

CREATE TABLE contacts (
  identity_address TEXT NOT NULL REFERENCES identities(address) ON DELETE CASCADE,
  address TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'learned' CHECK (source IN ('learned', 'manual')),
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  first_sent_at TEXT,
  last_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (identity_address, address)
);

CREATE INDEX contacts_identity_rank_idx
  ON contacts(identity_address, send_count DESC, last_sent_at DESC, address);
CREATE INDEX contacts_identity_name_idx
  ON contacts(identity_address, display_name COLLATE NOCASE);
CREATE INDEX messages_sender_lookup_idx
  ON messages(lower(sender_address), received_at DESC)
  WHERE direction = 'inbound' AND sender_name != '';

-- Recover every historical recipient we can prove was used by a successful send.
-- send_recipients includes Bcc; the stored message JSON covers older To/Cc sends.
WITH address_events(identity_address, address, message_row_id, sent_at) AS (
  SELECT m.identity_address,
    lower(CASE WHEN json_valid(j.value) THEN json_extract(j.value, '$.address') ELSE CAST(j.value AS TEXT) END),
    m.id, m.received_at
  FROM messages m,
    json_each(CASE WHEN json_valid(m.recipients_json) THEN m.recipients_json ELSE '[]' END) j
  WHERE m.direction = 'outbound' AND m.status = 'ready' AND m.identity_address IS NOT NULL
  UNION
  SELECT m.identity_address,
    lower(CASE WHEN json_valid(j.value) THEN json_extract(j.value, '$.address') ELSE CAST(j.value AS TEXT) END),
    m.id, m.received_at
  FROM messages m,
    json_each(CASE WHEN json_valid(m.cc_json) THEN m.cc_json ELSE '[]' END) j
  WHERE m.direction = 'outbound' AND m.status = 'ready' AND m.identity_address IS NOT NULL
  UNION
  SELECT m.identity_address, lower(sr.recipient), m.id, m.received_at
  FROM send_recipients sr
  JOIN send_requests req
    ON req.key_id = sr.key_id AND req.idempotency_key = sr.idempotency_key
  JOIN messages m ON m.id = req.message_row_id
  WHERE sr.status = 'sent' AND m.identity_address IS NOT NULL
), normalized_events AS (
  SELECT events.identity_address, trim(events.address) AS address, events.message_row_id, events.sent_at
  FROM address_events events
  JOIN identities i ON i.address = events.identity_address AND i.enabled = 1
  WHERE events.address IS NOT NULL AND events.address LIKE '%@%' AND events.address NOT LIKE '% %'
)
INSERT INTO contacts
  (identity_address, address, display_name, source, send_count, first_sent_at, last_sent_at)
SELECT events.identity_address, events.address,
  COALESCE((
    SELECT NULLIF(trim(m.sender_name), '')
    FROM messages m
    WHERE m.direction = 'inbound' AND lower(m.sender_address) = events.address
    ORDER BY m.received_at DESC
    LIMIT 1
  ), ''),
  'learned', COUNT(*), MIN(events.sent_at), MAX(events.sent_at)
FROM normalized_events events
GROUP BY events.identity_address, events.address;
