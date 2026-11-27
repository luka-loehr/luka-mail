# Security model

lmail handles confidential operational and personal email. Security-sensitive changes require clean TypeScript, Swift, and Rust builds; automated tests; OpenAPI parity checks; security-review validation (`python3 security-reviews/scripts/check_review_system.py`); dependency audits; and a Wrangler dry run.

## Trust boundaries

- Cloudflare terminates TLS for the Worker at your configured `MAIL_HOST` (for example, `mail.example.com`). Dedicated `mta-sts.*` hostnames fail closed and serve only `/.well-known/mta-sts.txt` for managed domains with full security headers.
- Native iPhone, iPad, and Mac apps authenticate in the system browser with an enrolled WebAuthn passkey. Passkey enrollment (`/auth/passkeys/register/*`) requires an unrestricted `lm_live_` administrator key with `keys:write` and `X-Admin-Confirmation: user-approved`.
- The native redirect contains only a short-lived, one-time authorization code. The client verifies state and exchanges the code with PKCE S256 before receiving an opaque 30-day bearer session.
- Native session hashes, credential relationships, expiry (`datetime(...) > datetime('now')`), and revocation state live in D1. Tokens are stored only in the local Keychain with `WhenUnlockedThisDeviceOnly` protection. HTTP redirects are disabled across both Apple and Rust API clients so bearer tokens are never forwarded across redirects.
- Both native bearer sessions and browser cookie sessions (`__Host-lmail-session`) are constrained to `NATIVE_SESSION_SCOPES` and enabled identities via `constrainedNativeSessionPolicy`, and cookie mutations enforce `SameSite=Strict` plus `Origin` / `Sec-Fetch-Site` verification.
- Push device registrations (`push_devices`) bind to the registering `native_session_hash` (`ON DELETE CASCADE`) and re-verify active session, key expiry/revocation, `mail:read` scope, and identity allowlists before every APNs delivery.
- The `lmail` CLI retains separate scoped API keys for automation and administration. Keys use least-privilege scopes, explicit identity allowlists, expiry, revocation, and domain-separated peppered hashes.
- A restricted key reaches only its allowlisted mailboxes: messages, raw mail, attachments, drafts (including overwriting one by id and reply-draft example history), contacts, autopilot rules/actions/counters, push registrations, external-account status and sync (`POST /v1/external/sync`), key listings (`GET /v1/keys`), and audit logs (`GET /v1/audit`) are scoped to the caller's policy. Account-wide deliverability telemetry (`GET /v1/deliverability`) and address mutations require an unrestricted key.
- Trusted-sender spam bypass (`isTrustedSender`) and alert deduplication (`collapseRepeats` / `tidyInbox`) require cryptographic sender authentication (`DMARC`, aligned `DKIM`, or aligned `SPF` on the receiving MTA's `Authentication-Results` header) so forged `From:` headers cannot bypass spam filtering or archive real alerts.
- Outbound sender-logo discovery validates every HTTPS target and manual redirect hop (`max 3` hops, port `443`, no private/local/IP literals) and sanitizes SVGs against scripts, SMIL, CSS escapes, external references, and `<use>` expansion bombs.
- Address, key, and passkey enrollment mutations require an unrestricted administrator key plus `X-Admin-Confirmation: user-approved` (`lmail --confirm-admin`).
- Authentication, API traffic, sending, and administrative/expensive operations enforce dedicated Cloudflare Rate Limiting bindings (`AUTH_RATE_LIMITER`, `API_RATE_LIMITER`, `SEND_RATE_LIMITER`, `ADMIN_RATE_LIMITER`).
- Inbound mail is accepted only for enabled identities and is capped at 10 MiB. API JSON bodies are capped at 7 MiB and encoded outbound mail at 5 MiB.
- Mail objects live in R2. Searchable metadata, identities, credentials, sessions, and bounded retention windows of audit/AI/push events live in D1. Worker secrets never enter Git.
- Failed inbound, draft, and push jobs retry boundedly before dead-letter handling terminates them cleanly.
- Outbound requests persist a content hash and per-recipient state before delivery. Ambiguous provider outcomes remain `unknown` and are not blindly retried.

## Native-session & client requirements

- Accept only the registered `lmail://auth/callback` (and legacy `lukamail://auth/callback`) redirect and reject arbitrary or nested redirect targets. PKCE prevents a different app from exchanging an intercepted one-time code; state binds the response to the initiating app session.
- Untrusted HTML emails render inside non-persistent `WKWebView` instances with `allowsContentJavaScript = false`, document-level `<link>`/`<meta>`/`<base>`/`<script>`/`<iframe>` stripping, CSP (`img-src data:` by default, `https: data:` when explicitly allowed), and compiled `WKContentRuleList` network blockers. Inline `cid:` attachments are restricted to safe raster image MIME types.
- Sign Out unregisters APNs push tokens, attempts server session revocation, removes Keychain credentials, clears session `UserDefaults`, and deletes both persistent caches and Quick Look temporary files.
- Never place access tokens in URLs, logs, analytics, crash reports, screenshots, or `UserDefaults`.

## Operational requirements

- Revoke a native session immediately when a device is lost; revoke its passkey credential if device trust is uncertain.
- Issue separate, expiring CLI keys for each agent or workload. Never share credentials.
- Review `lmail audit --all`, `lmail doctor`, and `lmail deliverability --hours 24` regularly, and keep `security-reviews/QUEUE.md` drained (`0` open tasks).
- DMARC aggregate and TLS-RPT reports terminate at dedicated identities. Managed domains publish enforced DMARC and MTA-STS policies.
- Deliverability telemetry uses an independent read-only Cloudflare token; DNS setup scripts (`npm run configure:deliverability`) accept scoped `CLOUDFLARE_API_TOKEN` bearer tokens.

## Reporting

Do not open public issues containing secrets or private mail. Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/luka-loehr/luka-mail/security/advisories/new) or by emailing `luka@lukaloehr.com`, and include request IDs—never bearer tokens.
