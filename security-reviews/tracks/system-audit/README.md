# System audit track

Repository: `luka-loehr/luka-mail`

## Review questions

- Supply chain & CI: SHA-pinned GitHub Actions, `permissions: contents: read`, `npm ci --ignore-scripts`, `npm audit`, `cargo clippy -- -D warnings`, OpenAPI 3.1 contract parity, and `security-reviews` validation on every push and PR.
- Apple & CLI clients: `WKWebView` sandboxing (`MailHTMLDocument.swift`, `MailWebView.swift`), `KeychainStore` protection (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), `MailCache` backup exclusion and sign-out wipe, and Rust CLI credential `0600` permissions + terminal escape sanitization.
- Public repository hygiene: zero secrets, personal emails, private IPs, or personal identifiers in source, configs, migrations, or git history.
