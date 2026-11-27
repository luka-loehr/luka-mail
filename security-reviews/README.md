# Security reviews

This folder organizes traceable security reviews and security-related audits of `luka-loehr/luka-mail` (**lmail**): the Cloudflare Worker API and mail pipeline (`src/worker/`, Hono + D1 + R2 + Queues + Workers AI Clef triage + WebAuthn passkeys + PKCE native sessions), the D1 schema (`migrations/`), the canonical OpenAPI 3.1 contract (`openapi/openapi.json`), the Rust CLI (`cli/`), and the native SwiftUI iOS/iPadOS and macOS clients (`ios/`). The method follows the `kiste-run` review register design, adapted to a public, self-hosted email repository.

## Goal

The system makes traceable:

- what was reviewed across Worker, OpenAPI contract, CLI, and Apple apps
- who reviewed it and with which model, session, and tooling
- which repository commit applied
- which redacted, reproducible evidence was collected
- which findings are open, fixed, accepted, rejected, or waiting for an owner decision
- how every finding, PASS statement, and fix was verified with evidence by its builder

## Tracks

- Architecture (`tracks/architecture/README.md`)
- Threat model (`tracks/threat-model/README.md`)
- Service and API pentest (`tracks/service-pentest/README.md`)
- Cryptographic implementation (`tracks/crypto-implementation/README.md`)
- System audit (`tracks/system-audit/README.md`)
- Quality and maintainability (`tracks/quality-maintainability/README.md`)
- Operations (`tracks/operations/README.md`)
- Privacy (`tracks/privacy/README.md`)

## Quick start

1. Read [`AGENTS.md`](AGENTS.md) completely.
2. Read [`AUTHORIZATION.md`](AUTHORIZATION.md).
3. For Worker/API tests read [`SERVICE_REVIEW_HARNESS.md`](SERVICE_REVIEW_HARNESS.md).
4. For authorization-page and WebView checks read [`BROWSER_REVIEW_HARNESS.md`](BROWSER_REVIEW_HARNESS.md).
5. Check [`INDEX.md`](INDEX.md) and [`QUEUE.md`](QUEUE.md).
6. Read the matching track file under `tracks/`.
7. Create a claim and run folder from `templates/`.
8. Document redaction, cleanup, and register sync before finishing.

## Rules

- Review runs analyze and change only `security-reviews/`.
- Fix runs follow [`FIX_AGENT_GUIDE.md`](FIX_AGENT_GUIDE.md), add regression tests, verify the fix, and record `Re-verify status: confirmed` with evidence.
- An empty register is not a PASS. Every PASS, finding, and fix carries concrete verification evidence.

## Human entry points

- [`humans_read_this_first.html`](humans_read_this_first.html): security state, owner decisions, PASS statements, and timeline.
- [`audits.html`](audits.html): audit, quality, operations, and privacy findings.

## Integrity check

```bash
python3 security-reviews/scripts/update_humans_read_this_first.py
python3 security-reviews/scripts/update_audits_html.py
python3 security-reviews/scripts/check_review_system.py
python3 -m unittest discover -s security-reviews/scripts -p 'test_*.py'
```
