# Security model

lmail handles confidential operational and personal email. Security-sensitive changes require clean TypeScript, Swift, and Rust builds; automated tests; dependency audits; a Wrangler dry run; remote migrations; and authenticated production smoke checks that never expose bearer values.

## Trust boundaries

- Cloudflare terminates TLS for the Worker at your configured `MAIL_HOST` (for example, `mail.example.com`). Dedicated `mta-sts.*` hostnames are isolated from the API and serve only `/.well-known/mta-sts.txt`.
- Native iPhone, iPad, and Mac apps authenticate in the system browser with an enrolled WebAuthn passkey.
- The native redirect contains only a short-lived, one-time authorization code. The client verifies state and exchanges the code with PKCE S256 before receiving an opaque 30-day bearer session.
- Native session hashes, credential relationships, expiry, and revocation state live in D1. Tokens are stored only in the local Keychain with `WhenUnlockedThisDeviceOnly` protection.
- The browser authorization surface is not webmail: it can authenticate and return to an approved `lmail://auth/callback` callback, but it cannot read or mutate mail.
- The `lmail` CLI retains separate scoped API keys for automation and administration. Keys use least-privilege scopes, explicit identity allowlists, expiry, revocation, and domain-separated peppered hashes.
- A restricted key reaches only its allowlisted mailboxes: messages, raw mail, attachments, drafts (including overwriting one by id), contacts, autopilot actions, push registrations, and external-account status are filtered by the allowlist, and an object in another mailbox is answered as not found. Saved agent chats and global autopilot mutations (settings, rules, brief, and sweep) are owner-only; per-message autopilot undo (`POST /v1/autopilot/actions/:id/undo`) and on-demand reply drafting (`POST /v1/autopilot/draft/:id`) are mailbox-scoped.
- Not mailbox-scoped by design, and free of mail content: autopilot settings and rules (readable with `mail:read`), knowledge-graph counters, and the sync triggers `POST /v1/external/sync` and `POST /v1/kg/sync` without an identity.
- Address and key mutations require an administrator key plus an explicit per-operation confirmation header (`X-Admin-Confirmation: user-approved`, set via `lmail --confirm-admin`). This prevents accidental privilege use but is not a cryptographic human-presence proof.
- Authentication, sending, and administrative mutations have independent edge rate limits; authenticated D1 limits provide an account-level backstop.
- Inbound mail is accepted only for enabled identities and is capped at 10 MiB. API JSON bodies are capped at 7 MiB and encoded outbound mail at 5 MiB.
- Mail objects live in R2. Searchable metadata, identities, credentials, sessions, and 180 days of audit events live in D1. Worker secrets never enter Git.
- Failed inbound jobs retry five times before the dead-letter consumer marks them failed.
- Outbound requests persist a content hash and per-recipient state before delivery. Ambiguous provider outcomes remain `unknown` and are not blindly retried.

## Native-session requirements

- Accept only the registered `lmail://auth/callback` (and legacy `lukamail://auth/callback`) redirect and reject arbitrary or nested redirect targets. PKCE prevents a different app from exchanging an intercepted one-time code; state binds the response to the initiating app session.
- Require 256 bits of client state and a high-entropy PKCE verifier; validate `code_challenge_method=S256`.
- Authorization codes must be consumed atomically, expire within minutes, and be bound to the exact redirect URI and PKCE challenge.
- Native access tokens must be opaque, hashed at rest, credential-bound, independently revocable, restricted to native-mail scopes and currently enabled identities, and valid for no more than 30 days.
- Sign Out must attempt server revocation before removing the local token; local cleanup must still succeed if the session is already expired or unreachable.
- Never place access tokens in URLs, logs, analytics, crash reports, screenshots, or `UserDefaults`.
- Clearing the local cache must not change authentication state. Signing out must remove both credentials and all cached private data.

## Operational requirements

- Revoke a native session immediately when a device is lost; revoke its passkey credential if device trust is uncertain.
- Issue separate, expiring CLI keys for each agent or workload. Never share credentials.
- Review `lmail audit --all`, `lmail doctor`, and `lmail deliverability --hours 24` regularly.
- Replace and revoke legacy `lm_device_` credentials after native migration.
- DMARC aggregate and TLS-RPT reports terminate at dedicated identities. Managed domains publish enforced DMARC and MTA-STS policies.
- Deliverability telemetry uses an independent read-only Cloudflare token; routing mutation credentials are not reused.
- Treat Cloudflare account access and the local Wrangler OAuth grant as production administrator access protected by phishing-resistant MFA.

## Reporting

Do not open public issues containing secrets or private mail. Report suspected vulnerabilities privately through [GitHub Security Advisories](https://github.com/luka-loehr/luka-mail/security/advisories/new) or by emailing `luka@lukaloehr.com`, and include request IDs—never bearer tokens.
