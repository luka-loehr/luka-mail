# Worker API

Base URL: `https://<your-mail-host>` (for example, `https://mail.example.com`). Everything under `/v1` needs credentials; the route table below is taken from `src/worker/api.ts`, `passkeys.ts`, and `native-auth.ts`.

## Authentication

| Credential | Form | Used by |
| --- | --- | --- |
| API key | `Authorization: Bearer lm_live_<16-char id>_<secret>` | `lmail` CLI, automation |
| Device key | `Authorization: Bearer lm_device_<id>_<secret>` (one year, one identity) | legacy app builds |
| Native session | `Authorization: Bearer <43-char opaque token>` (30 days, from passkey + PKCE) | iPhone, iPad, Mac apps |
| Web session | `__Host-lmail-session` cookie (passkey login); mutations must be same-origin | authorization page |

Every key has **scopes** and an **identity allowlist** (`null` = unrestricted administrator key). A request for a mailbox outside the allowlist is answered as if the object did not exist (`404`) or with `403` when the identity is named in the request.

Scopes: `account:read`, `mail:read`, `mail:write`, `mail:send`, `addresses:read`, `addresses:write`, `keys:read`, `keys:write`, `audit:read`. `<namespace>:*` and `*` are wildcards.

**Owner-only** routes need a key whose allowlist contains `OWNER_EMAIL` (or an unrestricted key). **Admin** routes need the header `X-Admin-Confirmation: user-approved` (`lmail --confirm-admin`), else `428`.

## Errors and limits

Errors are JSON: `{ "error": "...", "code": "...", "retryable": bool, "details"?: ..., "requestId": "..." }`. The same id is in the `X-Request-Id` header.

| Status | `code` | When |
| --- | --- | --- |
| 400 | `invalid_request` | Body is not JSON, fails its schema, or a query parameter is invalid |
| 401 | `unauthorized` | Missing, malformed, expired, or revoked credential (also for unknown `/v1` paths: authentication runs first) |
| 403 | `forbidden` | Scope missing, identity outside the key's allowlist, owner-only route, cross-origin cookie mutation |
| 404 | `not_found` | Object does not exist or lies in a mailbox the key cannot read |
| 409 | `conflict` | State conflict (idempotency key reused with other content, ambiguous id prefix, nothing to undo) |
| 413 | `payload_too_large` | Body above 7 MiB (`/auth`: 256 KiB) |
| 428 | – | Admin mutation without the confirmation header |
| 429 | `rate_limited` | `Retry-After: 60` |
| 500 | `internal_error` | Unexpected failure, on every route as JSON; details only in Workers Logs (under the request id for `/v1`) |

Rate limits per minute (`wrangler.jsonc`): 120 per IP before authentication, 300 per key, 30 sends per key, 10 admin mutations per key.

List reads return `ETag`; send `If-None-Match` to get `304`. Cursors (`nextCursor`, `nextBefore`) are opaque: pass them back unchanged.

## Public routes

| Route | Purpose |
| --- | --- |
| `GET /health` | `{ ok, service, mode, version }` |
| `GET /` | Service description |
| `GET /.well-known/mta-sts.txt` on `mta-sts.*` hosts | MTA-STS policy; these hosts serve nothing else |

## `/auth`

| Route | Auth | Purpose |
| --- | --- | --- |
| `GET /auth/status` | – | `{ authenticated, setupRequired, principal }` for the session cookie |
| `POST /auth/passkeys/register/options`, `…/register/verify` | static API key | Register a passkey for the key |
| `POST /auth/passkeys/login/options`, `…/login/verify` | – | Passkey login, sets the session cookie |
| `POST /auth/logout` | cookie | End the web session |
| `GET /auth/native/authorize` | – | Authorization page for the apps (PKCE S256, `lmail://auth/callback`) |
| `POST /auth/native/verify` | – | Passkey assertion → single-use code |
| `POST /auth/native/token` | – | Code + verifier → 30-day native session |
| `POST /auth/native/logout` | native session | Revoke the session |

## `/v1`: account and health

| Route | Scope | Notes |
| --- | --- | --- |
| `GET /v1/whoami` | `account:read` | Principal (key id, name, scopes, identities) and owner |
| `GET /v1/doctor` | `account:read` + `addresses:read` | Database, R2, queue, routing rules, DNS, external accounts; only what the key can access |
| `GET /v1/deliverability?hours=1..168` | `account:read` + `addresses:read` | Sending report, default 24 hours |
| `GET /v1/audit?limit&cursor&keyId&action` | `audit:read` | `action` is a literal substring (≤ 50 bytes), `keyId` ≤ 64 characters |

## `/v1`: mail

`identity=<address>` narrows a read to one mailbox. Folders: `inbox`, `sent`, `archive`, `trash`, `starred`, `all`, `spam` (virtual: what triage hid); snapshots also `drafts`.

| Route | Scope | Notes |
| --- | --- | --- |
| `GET /v1/summary` | `mail:read` | Counters per folder |
| `GET /v1/messages?folder&query&limit&cursor&identity` | `mail:read` | `query` ≤ 50 bytes, `limit` ≤ 100 |
| `GET /v1/messages/:id` | `mail:read` | Body, attachments, thread (≤ 100 messages) |
| `GET /v1/messages/:id/raw` | `mail:read` | `message/rfc822` |
| `GET /v1/messages/:id/sender-logo` | `mail:read` | BIMI/brand logo of a DMARC-authenticated sender |
| `PATCH /v1/messages/:id` | `mail:write` | `{ unread?, starred?, folder?: inbox\|sent\|archive\|trash, spam? }`; only visible (ready) messages |
| `GET /v1/attachments/:id` | `mail:read` | Download |
| `POST /v1/messages/send` | `mail:send` | `{ idempotencyKey (uuid), from, to[1..20], cc?, bcc?, subject?, text, html?, replyToMessageId?, attachments?[≤10] { filename, contentType, data (base64) } }`; at most 20 unique recipients |
| `GET /v1/send-requests/:idempotencyKey` | `mail:send` | Per-recipient delivery state of the key's own send |
| `GET /v1/mailbox-state?identity&after&wait=0..25` | `mail:read` | Long-poll wake-up signal |
| `GET /v1/mailbox-delta?identity&since&limit&cursor` | `mail:read` | Needs one exact identity; `resetRequired` asks for a snapshot |
| `GET /v1/mailbox-snapshot?folder&query&limit&identity&includeAddresses=0\|1` | `mail:read` (+ `addresses:read` for addresses) | Revision, summary, first page, drafts |
| `POST /v1/logo-backfill?cursor` | `mail:read` | Warm the sender-logo cache, 10 messages per call |
| `PUT /v1/push-devices`, `DELETE /v1/push-devices` | `mail:read` | `{ deviceToken (hex), environment: development\|production, identities[] }` |

## `/v1`: drafts and contacts

| Route | Scope | Notes |
| --- | --- | --- |
| `GET /v1/drafts?identity` | `mail:read` | Newest 100 |
| `PUT /v1/drafts` | `mail:write` | `{ id?, from, to?, cc?, bcc?, subject?, text?, replyToMessageId? }`; `id` is 1–64 of `A-Z a-z 0-9 . _ : -`. An existing id is overwritten only when its draft is in a mailbox the key can access (else `404`) |
| `DELETE /v1/drafts/:id` | `mail:write` | |
| `GET /v1/contacts?identity&query&limit` | `mail:read` | `query` ≤ 100 bytes, `limit` ≤ 200 |
| `POST /v1/contacts` | `mail:write` | `{ identity, address, displayName? }` |
| `PATCH /v1/contacts/:address` | `mail:write` | `{ identity, displayName }` |
| `DELETE /v1/contacts/:address?identity=` | `mail:write` | |

## `/v1`: agent

The agent has mailbox tools only and no send tool. Saved chats hold what it read in every mailbox, so they are owner-only.

| Route | Scope | Notes |
| --- | --- | --- |
| `POST /v1/agent` | `mail:read` | `{ prompt (≤ 8000), identity?, maxSteps 1..16, stream?, chatId? }`; `stream: true` is a saved chat turn (NDJSON, `application/x-ndjson`) |
| `GET /v1/agent/chats`, `GET /v1/agent/chats/:id` | `mail:read`, owner | |
| `POST /v1/agent/chats` | `mail:read`, owner | `{ chatId?, text, identity?, maxSteps? }` |
| `PATCH /v1/agent/chats/:id` | `mail:write`, owner | `{ title }` |
| `DELETE /v1/agent/chats/:id` | `mail:write`, owner | |
| `PATCH /v1/agent/chats/:id/drafts/:draftId` | `mail:write`, owner | `{ from?, to?, cc?, subject?, body?, status?: draft\|discarded }` |
| `POST /v1/agent/chats/:id/drafts/:draftId/send` | `mail:send`, owner | `{ idempotencyKey, …final edits }`: the only way an agent-written mail leaves |

## `/v1`: autopilot, external accounts, knowledge graph

| Route | Scope | Notes |
| --- | --- | --- |
| `GET /v1/autopilot` | `mail:read` | Settings, rules, today's spend, last 24 hours |
| `PATCH /v1/autopilot` | `mail:write`, owner | `{ enabled?, drafts?, brief?, dailyCapUsd? 0..20 }` |
| `POST /v1/autopilot/rules`, `PATCH`/`DELETE /v1/autopilot/rules/:id` | `mail:write`, owner | `{ category, action, identity?, senderMatch? (address or @domain), maxUrgency? 0..3, minConfidence? 0.5..1, enabled? }` |
| `GET /v1/autopilot/actions?limit&before&identity` | `mail:read` | `before` is the `nextBefore` timestamp of the previous page |
| `POST /v1/autopilot/actions/:id/undo` | `mail:write` | Full id or its first 8+ characters (letters, digits, `-`) |
| `POST /v1/autopilot/draft/:id` | `mail:write` | Draft a reply to one inbound message now |
| `POST /v1/autopilot/brief`, `POST /v1/autopilot/sweep` | `mail:write`, owner | Write the brief now / triage what has no verdict |
| `GET /v1/external/status` | `mail:read` | IMAP replication state of the external accounts the key can access |
| `POST /v1/external/sync` | `mail:write` | `{ identity?, maxMessages? 1..200 }` |
| `GET /v1/kg/status` | `mail:read` | Coverage counters |
| `POST /v1/kg/sync` | `mail:write` | `{ maxMessages? 1..100 }` |

## `/v1`: administration

| Route | Scope | Notes |
| --- | --- | --- |
| `GET /v1/addresses` | `addresses:read` | Enabled identities the key can access, managed domains |
| `POST /v1/addresses` | `addresses:write`, admin, unrestricted key | `{ address, displayName?, grantKeyIds? }`; creates the Email Routing rule, takes an unknown domain of an account zone under management |
| `PATCH /v1/addresses/:address` | same | `{ displayName }` |
| `DELETE /v1/addresses/:address` | same | Never the owner identity |
| `GET /v1/keys` | `keys:read` | No secrets, no hashes |
| `POST /v1/keys` | `keys:write`, admin | `{ name, scopes[], identities[] \| null, expiresAt? }`; a key cannot grant a scope or identity it does not hold; mail scopes need explicit identities |
| `POST /v1/keys/device` | `keys:write`, admin | `{ name?, identity }`: one-year device key |
| `DELETE /v1/keys/:id` | `keys:write`, admin | Revoke; not the calling key. A restricted key revokes only keys whose mailboxes are all its own (else `403`) |

Mutations and sensitive reads (`doctor`, `deliverability`, `keys`, `audit`, message detail and raw, attachments, send requests) are written to the audit log, kept 180 days.
