# Fix log: SEC-20261127-001500-SVC-001 SEC-20261127-001501-SVC-002 SEC-20261127-001502-CRYPTO-001 SEC-20261127-001503-SVC-003 SEC-20261127-001504-SVC-004 SEC-20261127-001505-ARCH-001 SEC-20261127-002000-SYS-001 SEC-20261127-002001-SYS-002 AUD-20261127-SYSTEM-001 AUD-20261127-OPS-001 AUD-20261127-PRIVACY-001 AUD-20261127-QUALITY-001

Fix log id: `20261127-004500-all-open-findings-lmail-lead`
Findings: SEC-20261127-001500-SVC-001 SEC-20261127-001501-SVC-002 SEC-20261127-001502-CRYPTO-001 SEC-20261127-001503-SVC-003 SEC-20261127-001504-SVC-004 SEC-20261127-001505-ARCH-001 SEC-20261127-002000-SYS-001 SEC-20261127-002001-SYS-002 AUD-20261127-SYSTEM-001 AUD-20261127-OPS-001 AUD-20261127-PRIVACY-001 AUD-20261127-QUALITY-001
Status: fixed
Agent: lmail-lead
Model: claude-opus-4-6
Session: lmail-lead session 9ce103f8-523d-4541-be37-a1c6ef728de0 of 2026-11-27
Start: 2026-11-27T00:30:00+01:00
End: 2026-11-27T00:56:00+01:00
Commits: 26f4d72
Deploy: n/a (self-hosted open-source repository; live deployment gated on operator go)

## Order

- Ordered by: owner request of 2026-11-27 (`Do all + OpenAPI + sec`: retire `lmail agent` and Vectorize KG, upgrade `DRAFT_MODEL` off retired GLM-5.3-Flash, ship OpenAPI 3.1 contract, run full security & system reviews, fix every finding, and drain `QUEUE.md`).
- Goal: zero open `SEC-*` or `AUD-*` findings, 100% drained `QUEUE.md`, full Worker + Rust CLI + Apple test verification.

## Changes

| File or resource | Change | Finding |
| --- | --- | --- |
| `src/worker/bimi.ts`, `inbound.ts`, `external.ts`, `spam.ts`, `autopilot.ts` | Strip RFC 5322 comments, evaluate topmost `Authentication-Results`, gate trust & repeat collapse on `senderPassedMailAuth`, enforce BIMI domain alignment | `SEC-20261127-001500-SVC-001` |
| `migrations/0025_security_hardening_v2.sql`, `src/worker/api.ts`, `push.ts`, `reply-drafts.ts` | Bind `push_devices.native_session_hash`, isolate restricted keys across `/v1/*`, scope `earlierMails` to exact `(identity_address, sender)` | `SEC-20261127-001501-SVC-002` |
| `src/worker/auth.ts`, `passkeys.ts`, `native-auth.ts` | Constrain `web_sessions`, enforce `X-Admin-Confirmation: user-approved` + `ADMIN_RATE_LIMITER`, `datetime(expires_at) > datetime('now')`, logout `Origin` check | `SEC-20261127-001502-CRYPTO-001` |
| `src/worker/logo-discovery.ts` | Manual 3-hop `safeFetch`, port 443 + special-use TLD block, CSS `\` escape & SMIL/`<use>` SVG hardening | `SEC-20261127-001503-SVC-003` |
| `src/worker/smtp.ts`, `mime.ts`, `imap.ts` | Reject pipelined post-`STARTTLS` bytes (`CVE-2011-0411`), implicit TLS 465, RFC 2047 45-byte folding, 16 MiB IMAP literal cap | `SEC-20261127-001504-SVC-004` |
| `src/worker/index.ts`, `mta-sts.ts`, `auth.ts`, `native-auth.ts` | Fail-closed `mta-sts.*` isolation after `securityHeaders`, per-request CSP script nonces, default `Cache-Control: no-store` | `SEC-20261127-001505-ARCH-001` |
| `ios/LukaMail/**`, `cli/src/main.rs` | `WKWebView` CSP + tag/attribute/HTTPS/CID raster hardening, `*ThisDeviceOnly` Keychain, protected `MailCache`, no-redirect HTTP clients, CLI ANSI/BiDi sanitizer + atomic `0600` writes | `SEC-20261127-002000-SYS-001`, `SEC-20261127-002001-SYS-002` |
| `migrations/0024_retire_agent_and_kg.sql`, `0025_security_hardening_v2.sql`, `openapi/openapi.json`, `scripts/*`, `.github/workflows/*`, `docs/*` | Retire agent/Vectorize, upgrade `DRAFT_MODEL` to `@cf/meta/llama-3.1-8b-instruct-fp8`, fix UTF-8 attachment `Content-Disposition`, per-identity `message_id` index, push DLQ + D1 pruning, OpenAPI 3.1 parity, SHA-pinned CI | `AUD-20261127-SYSTEM-001`, `AUD-20261127-OPS-001`, `AUD-20261127-PRIVACY-001`, `AUD-20261127-QUALITY-001` |

## Checks

| Check | Result |
| --- | --- |
| `npm run test:all` | pass (types, OpenAPI 50 paths/60 ops, tsc, eslint, 18 test files / 137 tests, build) |
| `npm audit --omit=dev --audit-level=high` | pass (0 vulnerabilities) |
| `npx wrangler deploy --dry-run` | pass (368.31 KiB gzip) |
| `cargo fmt --check && cargo clippy -- -D warnings && cargo test` | pass (27/27 tests, 0 warnings) |
| `xcodebuild test` (iOS) + `xcodebuild build` (macOS) | pass (39/39 tests) |
| `python3 security-reviews/scripts/check_review_system.py` | pass |

## Result

- All 8 `SEC-*` findings and 4 `AUD-*` findings are `fixed` (`0` open findings, `0` open queue tasks).
