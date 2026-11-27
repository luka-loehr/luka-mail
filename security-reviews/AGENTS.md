# AGENTS.md (security-reviews)

## Scope

These rules apply to every file under `security-reviews/` of `luka-loehr/luka-mail`.

## Purpose

`security-reviews/` holds traceable security review and audit artifacts for `lmail`: the Cloudflare Worker (`src/worker/`), D1 migrations (`migrations/`), OpenAPI 3.1 specification (`openapi/`), Rust CLI (`cli/`), and SwiftUI iOS/macOS apps (`ios/`). Because `luka-loehr/luka-mail` is a **public** repository, every file in `security-reviews/` must be strictly free of personal data, real user addresses, private network addresses, and secret material.

## Sources of truth

- `INDEX.md` is the canonical register (its generated block is rebuilt from `findings/`).
- `QUEUE.md` is the coordinating work list.
- `AUTHORIZATION.md` is the sole permission boundary for active tests.
- Individual findings live under `findings/`, runs under `runs/`, and fixes under `fix-logs/`.
- `humans_read_this_first.html` and `audits.html` are generated offline HTML views without external assets.

## Hard boundaries

- Never print, store, or commit secret values: `API_KEY_PEPPER`, `AUDIT_IP_PEPPER`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_DOMAIN_TOKEN`, `DELIVERABILITY_API_TOKEN`, `APNS_PRIVATE_KEY`, external IMAP/SMTP passwords, `lm_live_*` / `lm_device_*` tokens, native bearer tokens, or `__Host-lmail-session` cookies.
- Never touch live production mailboxes, Worker deployments, or personal domains during review runs; all active testing runs locally inside `workerd` (`npm test`) or local `wrangler dev --ip 127.0.0.1` against synthetic `@example.com` / `@example.org` data.
- Allowed evidence: redacted file/line references, HTTP status codes, header names/values without tokens, booleans, counts, test names, commit SHAs, and synthetic reproduction outcomes.

## Verify and re-verify

The agent that produces a finding, PASS statement, or fix verifies its own work with reproducible evidence:

1. Every confirmed finding or PASS statement records `Verify status: confirmed` with `Verify by`, `Verify model`, and `Verify session` plus concrete verification notes.
2. Every `fixed` finding references the commit SHA in `Fix`, sets `Deployed: n/a (public self-hosted source)` (or `yes` when applicable), and records `Re-verify status: confirmed` with test evidence in `## Status history`.
3. Run `python3 security-reviews/scripts/update_humans_read_this_first.py`, `python3 security-reviews/scripts/update_audits_html.py`, and `python3 security-reviews/scripts/check_review_system.py` before committing.

## File and ID rules

- Run IDs and claim files: `YYYYMMDD-HHMMSS-<track>-<scope>-<agent>` (`a-z`, `0-9`, `-` only).
- Security findings: `SEC-YYYYMMDD-HHMMSS-<CODE>-NNN` (`ARCH`, `TM`, `SVC`, `CRYPTO`, `SYS`, `OPS`, `PRIV`).
- Audit findings: `AUD-YYYYMMDD-<SCOPE>-NNN` (`SYSTEM`, `QUALITY`, `OPS`, `PRIVACY`).
- PASS statements: `PASS-YYYYMMDD-NNN` in `data/passes.json`.
- Queue tasks: `SECQ-YYYYMMDD-NNN` in `QUEUE.md`.
