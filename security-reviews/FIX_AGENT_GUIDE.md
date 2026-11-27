# Guide for fix agents

Status: binding. Applies when fixing `SEC-*` or `AUD-*` findings in `luka-loehr/luka-mail`.

## Procedure

1. Read `security-reviews/AGENTS.md`, the finding file under `findings/`, and its origin run report.
2. Create a fix log under `fix-logs/` from `templates/FIX_LOG_TEMPLATE.md`.
3. Implement the minimal, root-cause fix and add automated regression tests (`tests/*.test.ts`, `cli/src/main.rs`, or `ios/LukaMailTests/*.swift`) that fail without the fix and pass with it.
4. Run full verification:
   - `npm run test:all` (Cloudflare types, OpenAPI 3.1 parity check, TypeScript, ESLint, Vitest in `workerd`, build)
   - `npx wrangler deploy --dry-run`
   - `cargo fmt --manifest-path cli/Cargo.toml --check && cargo clippy --manifest-path cli/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path cli/Cargo.toml`
   - Regenerate registers and validate:
     `python3 security-reviews/scripts/update_humans_read_this_first.py && python3 security-reviews/scripts/update_audits_html.py && python3 security-reviews/scripts/check_review_system.py`
5. Update the finding to `Status: fixed` with `Fix` referencing the commit/fix-log, `Deployed: n/a (public self-hosted source)`, and `Re-verify status: confirmed` with agent, model, session, and verification evidence in `## Status history`.
