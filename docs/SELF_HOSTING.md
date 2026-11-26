# Self-Hosting Guide

This guide walks through deploying your own **lmail** instance on Cloudflare Workers, setting up your first administrator key and passkey, and connecting the `lmail` CLI and Apple apps.

## Prerequisites

- A Cloudflare account with at least one domain managed in Cloudflare DNS
- Cloudflare Email Routing and Email Sending enabled on your domain
- Node.js 22+ and `npm`
- Rust (optional, for the `lmail` CLI)
- Xcode 26+ and XcodeGen (optional, for building the iOS and macOS apps from source)

## 1. Provision Cloudflare resources

Create the D1 database, R2 bucket, Queues, and Vectorize index:

```bash
npx wrangler d1 create lmail
npx wrangler r2 bucket create lmail
npx wrangler queues create lmail-inbound
npx wrangler queues create lmail-inbound-dlq
npx wrangler vectorize create lmail-messages --dimensions=1024 --metric=cosine
```

## 2. Configure `wrangler.jsonc`

Edit `wrangler.jsonc` with your own resource IDs, custom domains, and variables:

- Replace `database_id` with the ID printed by `wrangler d1 create lmail`.
- Update `routes` to your API host (for example, `mail.example.com`) and `mta-sts.<your-domain>` hosts.
- Set `vars`:

| Variable | Description | Example |
| --- | --- | --- |
| `APP_NAME` | Display name shown on the passkey authorization page | `lmail` |
| `OWNER_EMAIL` | Primary owner address (used for owner-only routes and passkey enrollment) | `you@example.com` |
| `OWNER_NAME` | Owner display name used in agent and reply-draft prompts | `Alex Rivera` |
| `MAIL_HOST` | Public HTTPS hostname serving the Worker (required for WebAuthn RP ID) | `mail.example.com` |
| `WORKER_NAME` | Deployed Worker name used when creating Email Routing rules | `lmail` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID for deliverability and domain lookup APIs | `0123456789abcdef...` |
| `MANAGED_DOMAINS_JSON` | JSON map of `domain -> zone_id`; required for `mta-sts.*` policy hosting and deliverability checks | `{"example.com":"<zone-id>"}` |
| `DMARC_REPORT_ADDRESS` | Optional DMARC aggregate report address (defaults to `""`, disabling `rua` checks until set) | `dmarc@example.com` |
| `TLS_REPORT_ADDRESS` | Optional TLS-RPT report address (defaults to `""`, disabling TLS-RPT checks until set) | `tlsrpt@example.com` |
| `APNS_TOPIC` | Bundle identifier for Apple Push Notifications (only if using direct APNs) | `com.example.lmail` |
| `OWNER_TIMEZONE` | IANA timezone for reply drafts and daily briefs | `UTC` |
| `OWNER_PROFILE` | Optional short bio for autopilot triage context | `""` |
| `OWNER_STYLE_GUIDE` | Optional writing-style instructions for reply drafts and agent | `""` |
| `IDENTITY_SIGNATURES_JSON` | Optional JSON map of `address-or-domain -> signature` appended to reply drafts | `{}` |
| `AGENT_SENDER_DOMAINS` | Optional comma-separated domains classified as `agent` mail in triage | `""` |
| `AGENT_MODEL` | Workers AI model for the mailbox agent | `@cf/zai-org/glm-5.3-flash` |
| `KG_MODEL` | Workers AI model for knowledge-graph extraction | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |

After editing bindings in `wrangler.jsonc`, regenerate the TypeScript binding definitions:

```bash
npm run cf:types
```

## 3. Set Worker secrets

Generate strong random peppers and upload your Worker secrets (never commit secrets to Git):

```bash
openssl rand -hex 32 | npx wrangler secret put API_KEY_PEPPER
openssl rand -hex 32 | npx wrangler secret put AUDIT_IP_PEPPER
npx wrangler secret put CLOUDFLARE_API_TOKEN
npx wrangler secret put DELIVERABILITY_API_TOKEN
```

Optional secrets:

- `CLOUDFLARE_DOMAIN_TOKEN` — dedicated Cloudflare token for onboarding new domains via `POST /v1/addresses` (falls back to `CLOUDFLARE_API_TOKEN` when unset).
- `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` — enable direct APNs alerts for self-built iOS apps.
- Any secret name referenced by `external_accounts.password_secret` — for IMAP/SMTP external account replication.

## 4. Run migrations and deploy

Apply all D1 migrations and deploy the Worker:

```bash
npm run db:migrate:remote
npm run deploy
curl -s https://mail.example.com/health
```

## 5. Bootstrap your first identity and administrator key

API keys use the format `lm_live_<16-char id>_<80..100-char secret>` (base64url characters `[A-Za-z0-9_-]`) and are stored in D1 as unpadded base64url `SHA-256("${API_KEY_PEPPER}:${secret}")`.

Generate a bootstrap administrator key and insert your primary owner identity and key into D1 using the exact `API_KEY_PEPPER` you uploaded in step 3:

```bash
API_KEY_PEPPER="<your-api-key-pepper>" \
OWNER_EMAIL="you@example.com" \
ZONE_ID="<your-cloudflare-zone-id>" \
node -e '
const crypto = require("node:crypto");
const id = crypto.randomBytes(12).toString("base64url");
const secret = crypto.randomBytes(64).toString("base64url");
const hash = crypto.createHash("sha256").update(`${process.env.API_KEY_PEPPER}:${secret}`).digest("base64url");
const owner = process.env.OWNER_EMAIL.toLowerCase();
const zone = process.env.ZONE_ID;
console.log("ADMIN TOKEN (save this now):", `lm_live_${id}_${secret}`);
console.log(`INSERT INTO identities (address, zone_id, routing_rule_id, enabled) VALUES (\x27${owner}\x27, \x27${zone}\x27, \x27bootstrap-owner\x27, 1);`);
console.log(`INSERT INTO api_keys (id, name, secret_hash, scopes_json) VALUES (\x27${id}\x27, \x27bootstrap-admin\x27, \x27${hash}\x27, \x27["*"]\x27);`);
'
```

Run the two printed `INSERT` statements against your remote D1 database with `npx wrangler d1 execute lmail --remote --command "..."`.

Once your administrator key is created:

1. Point an Email Routing rule in Cloudflare for `you@example.com` to your deployed `lmail` Worker (and update `routing_rule_id` in `identities` if desired).
2. Configure DNS deliverability records (DMARC, MTA-STS, TLS-RPT) either manually or via:

```bash
CF_API_EMAIL=you@example.com \
CF_API_KEY=... \
CF_ZONES_JSON='{"example.com":"<zone-id>"}' \
ROOT_DOMAIN=example.com \
DMARC_REPORT_ADDRESS=dmarc@example.com \
TLS_REPORT_ADDRESS=tlsrpt@example.com \
npm run configure:deliverability
```

3. Install and log in with the `lmail` CLI:

```bash
cargo install --path cli
lmail login --endpoint https://mail.example.com
lmail doctor
```

4. Enroll your first passkey so the iPhone, iPad, and Mac apps can sign in. Open `https://mail.example.com/auth/native/authorize` in a modern browser (Safari 18.4+, Chrome, or Firefox — this HTML endpoint allows same-origin `fetch()` calls under the worker's CSP even when opened without query parameters) and run this snippet in the browser DevTools Console with your administrator token:

```js
const token = "lm_live_...";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
const { challengeId, options } = await fetch("/auth/passkeys/register/options", { method: "POST", headers }).then((r) => r.json());
const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(options) });
await fetch("/auth/passkeys/register/verify", {
  method: "POST",
  headers,
  body: JSON.stringify({ challengeId, name: "Primary Passkey", response: cred.toJSON() }),
}).then((r) => r.json());
```

Once `{ registered: true }` is returned, open the iPhone, iPad, or Mac app, enter `mail.example.com`, and sign in with your passkey.

## External IMAP/SMTP accounts (optional)

lmail can replicate any external IMAP mailbox into D1 and R2 and send through its SMTP server:

1. Store the mailbox password as a Worker secret (for example, `npx wrangler secret put WORK_IMAP_PASSWORD`).
2. Insert the identity (`kind = 'external'`) and matching row in `external_accounts` with `password_secret = 'WORK_IMAP_PASSWORD'`.
3. Trigger an initial sync with `lmail external sync --full`.

## Local development

```bash
npm ci
npm run test:all
npm run db:migrate:local
npm run dev
```

All Worker tests run locally inside `workerd` via `@cloudflare/vitest-plugin` against ephemeral D1, R2, and mocked AI/APNs/IMAP/SMTP services. Nothing in `npm test` touches Cloudflare.
