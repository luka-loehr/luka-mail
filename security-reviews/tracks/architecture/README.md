# Architecture track

Repository: `luka-loehr/luka-mail`

## Review questions

- Host isolation: `mta-sts.<domain>` serves only `GET /.well-known/mta-sts.txt` (`mta-sts.ts`); API and auth routes are unreachable on `mta-sts.*` hosts.
- Security headers (`auth.ts`): dynamic SHA-256 inline script CSP on HTML, `default-src 'none'; frame-ancestors 'none'` on JSON/API responses, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and `Cache-Control: no-store` on `/auth/*` and `/v1/*`.
- Trust boundaries between Worker, D1, R2, Queues, Workers AI, Apple apps, and Rust CLI match `SECURITY.md` and `openapi/openapi.json`.
