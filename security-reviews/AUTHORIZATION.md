# Authorization for security reviews

Status: binding for `luka-loehr/luka-mail`.
Repository: `luka-loehr/luka-mail` (public open-source repository).

## Principle

All active security testing runs locally against ephemeral `workerd` (`npm test`), local `wrangler dev --port 8790 --ip 127.0.0.1`, local Rust CLI (`cargo test`), and local Xcode simulator/macOS test suites. Live personal mail deployments are strictly out of scope for review runs.

## Authorized targets

| Target | Status | Notes |
| --- | --- | --- |
| Ephemeral `workerd` harness (`npm test` / `vitest`) | authorized, full active testing | authn/authz, WebAuthn/PKCE, rate limits, MIME/inbound/outbound fuzzing, SQL/D1 triggers, SSRF mocks, autopilot triage. |
| Local Worker: `npx wrangler dev --port 8790 --ip 127.0.0.1` | authorized, full active testing | bind to `127.0.0.1` only, synthetic `@example.com` identities and `.dev.vars` test peppers only. |
| Local Rust CLI (`cli/`) and Apple test targets (`ios/`) | authorized, full active testing | unit, parser, WebView HTML sandboxing, PKCE callback validation, and Demo Mode checks. |
| Public repository metadata (`github.com/luka-loehr/luka-mail`) | passive and low volume only | read-only workflow, branch, and advisory checks; at most 20 requests per run; no load, stress or dos. |

## Production limits

- Live personal mail instances (`<owner-email>` and deployed personal Workers) are **never** targeted by review runs (`production_requests: "none"`).
- Passive checks against GitHub or public docs stay passive and low volume only (at most 20 requests, no load, stress or dos).

## Never

- Never send real e-mail to external addresses during security testing; mock `EMAIL` / SMTP transports or stay inside local `workerd` tests.
- Never delete or modify production data of the owner account (`<owner-email>`) or touch live Cloudflare Workers, D1 databases, R2 buckets, Queues, or DNS zones.
- Never touch other workers or infrastructure outside this repository.
- Never print, log, screenshot or commit secret values (`API_KEY_PEPPER`, `AUDIT_IP_PEPPER`, `CLOUDFLARE_API_TOKEN`, `APNS_PRIVATE_KEY`, bearer tokens, session cookies, or private keys).
- Never commit personal email addresses, private Tailscale/LAN IPv4 addresses, or internal hostnames to this public repository.

## Allowed test types

- Static analysis across TypeScript, SQL migrations, OpenAPI schemas, Rust, Swift, and GitHub Actions workflows.
- Full active negative, boundary, concurrency, SSRF, MIME/HTML injection, and tenancy/isolation tests in local `workerd` (`vitest`), `cargo test`, and `xcodebuild test`.
- Dependency and supply-chain checks (`npm audit`, action SHA pinning, OpenAPI parity).

## Abort criteria

Stop immediately if a command risks contacting a live mail deployment, sending a real external email, or writing non-synthetic data into the repository.
