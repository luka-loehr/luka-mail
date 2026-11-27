# Commands executed

- `npm run test:all` (cf:types:check, openapi:check, tsc -b, eslint, vitest 18 files / 137 tests, build)
- `npm audit --omit=dev --audit-level=high` (0 vulnerabilities)
- `npx wrangler deploy --dry-run --outdir /tmp/lmail-dryrun`
- `cargo fmt --manifest-path cli/Cargo.toml --check && cargo clippy --manifest-path cli/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path cli/Cargo.toml` (27/27 tests)
- `xcodebuild -project ios/LukaMail.xcodeproj -scheme LukaMail test && xcodebuild -project ios/LukaMail.xcodeproj -scheme LukaMailMac build` (39/39 tests)
- `python3 security-reviews/scripts/check_review_system.py`
