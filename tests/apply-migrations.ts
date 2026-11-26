import { env } from "cloudflare:workers";
import { applyD1Migrations, type D1Migration } from "cloudflare:test";

const testEnv = env as Cloudflare.Env & { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

// Seed synthetic identities and an external IMAP/SMTP account for tests.
await testEnv.DB.batch([
  testEnv.DB.prepare(`INSERT OR IGNORE INTO identities (address, display_name, zone_id, routing_rule_id, kind) VALUES
    ('owner@example.com', 'Owner', '11111111111111111111111111111111', 'rule-owner-example-com', 'routed'),
    ('management@aws.example.com', 'AWS Management', '11111111111111111111111111111111', 'rule-mgmt-aws-example-com', 'routed'),
    ('billing@aws.example.com', 'AWS Billing', '11111111111111111111111111111111', 'rule-billing-aws-example-com', 'routed'),
    ('prod@aws.example.org', 'Org Production', '22222222222222222222222222222222', 'rule-prod-aws-example-org', 'routed'),
    ('dev@aws.example.net', 'Net Development', '33333333333333333333333333333333', 'rule-dev-aws-example-net', 'routed'),
    ('external@ext.example.org', 'Owner (External)', 'external', 'external:external@ext.example.org', 'external')`),
  testEnv.DB.prepare(`INSERT OR IGNORE INTO external_accounts
    (identity_address, imap_host, imap_port, smtp_host, smtp_port, username, password_secret)
    VALUES ('external@ext.example.org', 'mail.ext.example.org', 993, 'mail.ext.example.org', 587, 'external@ext.example.org', 'EXTERNAL_MAIL_PASSWORD')`),
]);
