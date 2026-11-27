# Security review register

Updated: 2026-11-27

This register is the canonical overview of review runs, security findings (`SEC-*`), audit findings (`AUD-*`), PASS statements, and builder self-verification for `luka-loehr/luka-mail`. Details stay in the linked finding files, [QUEUE.md](QUEUE.md), and `runs/`. The block between the markers is generated from `findings/`, `data/passes.json`, and `runs/` by `scripts/update_humans_read_this_first.py`.

## System state

- 2026-11-27: security review system initialized and executed end-to-end across Worker/Auth/Mail (`20261127-001500-service-pentest-worker-mail-auth-service-reviewer`), Apple/WebView/CLI (`20261127-002000-browser-clients-webview-cli-client-reviewer`), and Whole-Codebase/Ops/Privacy (`20261127-002500-system-audit-whole-codebase-ops-privacy-system-auditor`). All 8 `SEC-*` findings and 4 `AUD-*` findings were fixed and self-verified in `26f4d72` ([fix log](fix-logs/20261127-004500-all-open-findings-lmail-lead.md)), 12 `PASS-*` statements were confirmed with test evidence, and [QUEUE.md](QUEUE.md) is fully drained (`0` open tasks).

<!-- BEGIN GENERATED: scripts/update_humans_read_this_first.py -->

## Counts

| Kind | open | in_progress | owner-decision | fixed | accepted | rejected | duplicate | blocked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| SEC | 0 | 0 | 0 | 8 | 0 | 0 | 0 | 0 |
| AUD | 0 | 0 | 0 | 4 | 0 | 0 | 0 | 0 |

Verify pending: 0 findings, 0 PASS statements. Re-verify pending: 0 fixes.

## Security findings (SEC)

| ID | Status | Severity | Track | Title | Fix | Verify | Re-verify | Needs live |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [SEC-20261127-001500-SVC-001](findings/SEC-20261127-001500-SVC-001.md) | fixed | high | service-pentest | Spoofed From headers and RFC 5322 Authentication-Results comments bypass sender trust, BIMI, and repeat-collapse autopilot | 26f4d72 | confirmed | confirmed | no |
| [SEC-20261127-001501-SVC-002](findings/SEC-20261127-001501-SVC-002.md) | fixed | high | service-pentest | Identity-scoped API keys access out-of-scope autopilot rules, external syncs, key metadata, audit rows, and cross-session push tokens | 26f4d72 | confirmed | confirmed | no |
| [SEC-20261127-001502-CRYPTO-001](findings/SEC-20261127-001502-CRYPTO-001.md) | fixed | high | crypto-implementation | Browser web sessions inherit unrestricted parent key scopes, passkey bootstrap lacks human-confirmation gate, and SQLite datetime comparisons mis-handle ISO-8601 expiry | 26f4d72 | confirmed | confirmed | no |
| [SEC-20261127-001503-SVC-003](findings/SEC-20261127-001503-SVC-003.md) | fixed | medium | service-pentest | Logo discovery follows unchecked HTTP redirects, permits non-standard ports and special-use TLDs, and misses CSS backslash escapes in SVG | 26f4d72 | confirmed | confirmed | no |
| [SEC-20261127-001504-SVC-004](findings/SEC-20261127-001504-SVC-004.md) | fixed | medium | service-pentest | SMTP STARTTLS buffer carryover (CVE-2011-0411), unfolded RFC 2047 encoded-words, and unbounded IMAP literal allocation | 26f4d72 | confirmed | confirmed | no |
| [SEC-20261127-001505-ARCH-001](findings/SEC-20261127-001505-ARCH-001.md) | fixed | medium | architecture | MTA-STS middleware fails open on unmanaged mta-sts.* hosts, skips securityHeaders, and inline passkey HTML uses unsafe-inline script CSP | 26f4d72 | confirmed | confirmed | no |
| [SEC-20261127-002000-SYS-001](findings/SEC-20261127-002000-SYS-001.md) | fixed | medium | system-audit | Apple WKWebView HTML sanitizer misses SVG/base/meta/form tags, inline CID injection, and unsafe attachment temp paths | 26f4d72 | confirmed | confirmed | no |
| [SEC-20261127-002001-SYS-002](findings/SEC-20261127-002001-SYS-002.md) | fixed | medium | system-audit | Apple keychain/cache lifecycle and Rust CLI redirect, terminal-escape, and credential-file permissions hardening | 26f4d72 | confirmed | confirmed | no |

## Audit findings (AUD)

| ID | Status | Severity | Track | Title | Fix | Verify | Re-verify | Needs live |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [AUD-20261127-OPS-001](findings/AUD-20261127-OPS-001.md) | fixed | medium | operations | Retired Workers AI model (@cf/zai-org/glm-5.3-flash), zombie push-DLQ loops, unbounded table growth, and unpinned CI workflows | 26f4d72 | confirmed | confirmed | no |
| [AUD-20261127-SYSTEM-001](findings/AUD-20261127-SYSTEM-001.md) | fixed | medium | system-audit | Unicode attachment filenames trigger HTTP 500 ByteString crash, global message_id index causes cross-identity dedup collisions, and delta triggers omit spam/triage fields | 26f4d72 | confirmed | confirmed | no |
| [AUD-20261127-PRIVACY-001](findings/AUD-20261127-PRIVACY-001.md) | fixed | low | privacy | Privacy, security, and self-hosting documentation drift after retiring agent/Vectorize and adding retention + passkey/push disclosures | 26f4d72 | confirmed | confirmed | no |
| [AUD-20261127-QUALITY-001](findings/AUD-20261127-QUALITY-001.md) | fixed | low | quality-maintainability | Missing machine-readable OpenAPI 3.1 contract, client/server parity gate, and dead schema/dependency cleanup | 26f4d72 | confirmed | confirmed | no |

## PASS statements (verified by their author with evidence)

| ID | Verify | Scope | Statement | Origin run |
| --- | --- | --- | --- | --- |
| PASS-20261127-001 | confirmed | worker-auth-crypto | Bearer API keys (`lm_live_`, `lm_device_`) and session tokens (`__Host-lmail-session`, native bearer tokens) are hashed with SHA-256 or HMAC-SHA-256 (`API_KEY_PEPPER` with legacy SHA-256 fallback) and compared in constant time via `crypto.subtle.timingSafeEqual` before authorization. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-002 | confirmed | worker-crypto-at-rest | External IMAP/SMTP credentials in `external_accounts` are encrypted at rest with AES-256-GCM using random 96-bit IVs and HKDF-SHA-256 subkeys derived from `MASTER_KEY` (`info = lmail-external-account-v1`), and decrypted secrets never appear in API responses or audit logs. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-003 | confirmed | worker-and-apple-passkeys-pkce | Native iOS and macOS passkey sign-in (`src/worker/native-auth.ts`, `ios/LukaMail/Services/NativeAuthSession.swift`) enforces OAuth 2.1 PKCE `S256` with 256-bit random verifiers, single-use atomic D1 `DELETE ... RETURNING` challenge/code consumption, strict RP ID / origin verification via `@simplewebauthn/server` 13.3.2, and per-request CSP script nonces. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-004 | confirmed | worker-d1-sql-safety | All SQL queries across `src/worker/*.ts` use parameterized D1 `.prepare(...).bind(...)` statements with zero string-interpolated user values; dynamic SQL fragments (`identityAccess`, `folderWhere`, `ftsQuery`) interpolate only hardcoded column names or `?` placeholders. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-005 | confirmed | worker-ai-triage-and-cost-caps | Inbound email triage and spam filtering run exclusively on Cloudflare's purpose-built Clef models (`@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`) with sender authentication (`senderPassedMailAuth`) gating trusted-contact fast paths and autopilot repeat collapsing, while reply drafts and daily briefs use `@cf/meta/llama-3.1-8b-instruct-fp8` under hard daily USD/request budgets. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-006 | confirmed | worker-outbound-mime-and-send | Outbound MIME assembly (`src/worker/mime.ts`) strips CR/LF from header tokens, folds non-ASCII headers into RFC 2047 UTF-8 base64 words <= 75 chars, validates attachment base64 payloads and byte budgets, and enforces idempotency keys + per-recipient outbound delivery records. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-007 | confirmed | worker-edge-headers-and-mta-sts | Global Hono edge middleware (`securityHeaders` + `isolateMtaStsHosts`) sets `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: no-store`, and strict CSP on every response while failing closed with 404 on all non-policy `mta-sts.*` paths. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-008 | confirmed | worker-apns-privacy-and-session-binding | APNs push notifications (`src/worker/push.ts`) transmit only opaque `messageId`, `threadId`, `identity`, and unread badge count (zero sender, subject, or body content in the Apple push payload), sign ES256 provider JWTs via WebCrypto P-256, and cascade-delete device tokens when their `native_sessions` token is revoked or expired. | `runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer` |
| PASS-20261127-009 | confirmed | apple-webview-email-isolation | Apple iOS and macOS `WKWebView` email rendering (`MailHTMLDocument.swift`, `MailWebView.swift`) enforces an embedded `Content-Security-Policy` blocking scripts/frames/connect/forms, strips active HTML/SVG/meta/base/form/media elements and `on*`/`srcdoc` attributes, blocks remote images by default (and permits only `https:`/`data:image/*` when opted in), and restricts external link handoff to `https` and `mailto`. | `runs/20261127-002000-browser-clients-webview-cli-client-reviewer` |
| PASS-20261127-010 | confirmed | rust-cli-transport-and-terminal-safety | Rust CLI (`cli/src/main.rs`) disables HTTP redirects, enforces HTTPS (allowing HTTP only on loopback), sanitizes ANSI/OSC/C0/C1/BiDi terminal control sequences on both human and `--json` outputs, and writes credentials and downloaded attachments atomically with `0600` Unix permissions. | `runs/20261127-002000-browser-clients-webview-cli-client-reviewer` |
| PASS-20261127-011 | confirmed | openapi-contract-parity | Canonical OpenAPI 3.1.0 specification (`openapi/openapi.json` and `GET /openapi.json`) covers all 50 paths and 60 HTTP operations with zero undocumented Worker routes, zero ghost operations, and automated parity checks against Rust CLI and Apple `APIClient` endpoints in CI. | `runs/20261127-002500-system-audit-whole-codebase-ops-privacy-system-auditor` |
| PASS-20261127-012 | confirmed | supply-chain-and-open-source-hygiene | `npm audit` reports 0 vulnerabilities across runtime and development dependencies, GitHub Actions workflows pin every third-party action to a full 40-char commit SHA with `permissions: contents: read` and `npm ci --ignore-scripts`, and repository-wide secret/personal-data scans confirm zero leaked tokens, keys, or personal domains. | `runs/20261127-002500-system-audit-whole-codebase-ops-privacy-system-auditor` |

## Runs

| Run | Track | Status | Register | Redaction |
| --- | --- | --- | --- | --- |
| [20261127-001500-service-pentest-worker-mail-auth-service-reviewer](runs/20261127-001500-service-pentest-worker-mail-auth-service-reviewer/report.md) | service-pentest | completed | synced | checked |
| [20261127-002000-browser-clients-webview-cli-client-reviewer](runs/20261127-002000-browser-clients-webview-cli-client-reviewer/report.md) | browser | completed | synced | checked |
| [20261127-002500-system-audit-whole-codebase-ops-privacy-system-auditor](runs/20261127-002500-system-audit-whole-codebase-ops-privacy-system-auditor/report.md) | system-audit | completed | synced | checked |

<!-- END GENERATED -->
