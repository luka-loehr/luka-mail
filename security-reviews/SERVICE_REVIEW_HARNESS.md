# Service review harness

Status: binding. Applies to Worker HTTP API, mail pipeline, D1/R2, and CLI integration tests in `luka-loehr/luka-mail`.

## Local test environments

1. **Primary (`workerd` via Vitest)**: `npm test` runs the real Cloudflare Workers runtime (`@cloudflare/vitest-plugin`) with all D1 migrations (`migrations/0001..0024`), ephemeral R2 (`MAIL`), mocked AI/APNs/IMAP/SMTP bindings, and configurable rate limiters.
2. **Local dev server (when interactive HTTP needed)**: `npx wrangler dev --port 8790 --ip 127.0.0.1 --persist-to <scratch-dir>` using synthetic test peppers in `.dev.vars` (never printed or committed) and `@example.com` identities only.
3. **Contract verification**: `npm run openapi:check` and `npx vitest run tests/openapi-contract.test.ts` verify 1-to-1 route parity between Hono, `openapi/openapi.json`, the Rust CLI, and the Swift `APIClient`.

## Mandatory checks per review scope

- Authentication: `lm_live_`, `lm_device_`, 30-day native bearer tokens, `__Host-lmail-session` cookies, constant-time hash comparison, passkey registration restrictions, and PKCE S256 single-use code exchange.
- Authorization & isolation: every `/v1/*` route with missing scopes, restricted `allowedIdentities`, non-owner credentials on owner-only endpoints, and missing `X-Admin-Confirmation: user-approved` on admin mutations (`428`).
- Mail & outbound fetch safety: DMARC authentication gating for trusted senders and BIMI logos, bounded HTTPS-only logo discovery without redirect SSRF or port scanning, attachment `Content-Disposition` sanitization, and 7 MiB / 10 MiB size limits.
- Cleanup & redaction: `production_requests` must be `"none"`, and all test artifacts use `@example.com` / `@example.org` addresses.
