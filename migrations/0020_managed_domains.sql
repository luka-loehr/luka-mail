-- Domains taken under management at run time by `lmail address add`:
-- any domain or subdomain of a zone in the Cloudflare account. The fixed
-- list in src/worker/config.ts stays the set with MTA-STS and
-- deliverability checks.
CREATE TABLE IF NOT EXISTS managed_domains (
  domain TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
