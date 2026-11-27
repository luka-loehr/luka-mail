# Privacy Policy

**Effective date:** November 27, 2026

**lmail** is an open-source, self-hosted email client for iPhone, iPad, and Mac, paired with a self-hosted Cloudflare Worker backend.

## Data collection

lmail does not collect, sell, rent, or share personal data, analytics, crash telemetry, or advertising identifiers with the developer.

## How your data is handled

- **Self-hosted server**: When you sign in, the app communicates exclusively with the self-hosted lmail server URL you enter. All email messages, drafts, contacts, and authentication sessions stay on your own Cloudflare infrastructure (Workers, D1, R2, Queues) and your device.
- **Cloudflare Workers AI (self-hosted server)**: On your Cloudflare account, inbound triage runs Cloudflare Workers AI (`@cf/cloudflare/clef` and `@cf/cloudflare/clef-flash`), and optional reply drafts and the daily brief run your configured `DRAFT_MODEL` (default `@cf/meta/llama-3.1-8b-instruct-fp8`). You can pause or cap AI spending at any time via `PATCH /v1/autopilot`.
- **Apple Push Notifications (optional)**: If you configure direct APNs credentials (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`) on your Worker and grant notification permission on iOS, your Worker sends signed push alerts (sender display name or address, subject line, thread ID, message ID, and mailbox identity) through Apple Push Notification service (`api.push.apple.com`) for active native sessions. Signing out unregisters the device and revokes the session.
- **Sender brand logos**: For inbound messages that pass DMARC alignment (and outbound recipients), your Worker resolves brand icons via Cloudflare DNS-over-HTTPS (`cloudflare-dns.com`), BIMI / sender HTTPS domains, and SHA-256 email hashes against Gravatar / Libravatar, caching results in your R2 bucket and D1 database for 30 days.
- **On-device storage**: Your 30-day session token is stored in Apple's Keychain (`WhenUnlockedThisDeviceOnly`). Offline message caches are stored locally on your device with file protection enabled (`completeFileProtection`) and excluded from cloud backups.
- **Demo Mode**: When using Demo Mode, all sample messages and interactions run entirely on-device with zero network requests.
- **Remote images & beacons**: Remote images, cleartext `http://` resources, and HTML `<link>`/`<meta>`/`<base>` resource hints in emails are blocked by default via both Content Security Policy and WebKit content-blocking rules until you explicitly allow remote HTTPS images.

## Data deletion

Signing out of lmail unregisters push notifications, revokes your session on your server, and deletes your local session token, offline cache, and temporary Quick Look preview files from the device.

## Contact

For privacy questions, open an issue at [github.com/luka-loehr/luka-mail/issues](https://github.com/luka-loehr/luka-mail/issues) or email [luka@lukaloehr.com](mailto:luka@lukaloehr.com).
