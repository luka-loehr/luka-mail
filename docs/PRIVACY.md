# Privacy Policy

**Effective date:** November 26, 2026

**lmail** is an open-source, self-hosted email client for iPhone, iPad, and Mac.

## Data collection

lmail does not collect, sell, rent, or share personal data, analytics, crash telemetry, or advertising identifiers with the developer or any third party.

## How your data is handled

- **Self-hosted server**: When you sign in, the app communicates exclusively with the self-hosted lmail server URL you enter. All email messages, drafts, contacts, and authentication sessions stay on your own Cloudflare infrastructure and your device.
- **On-device storage**: Your 30-day session token is stored in Apple's Keychain (`WhenUnlockedThisDeviceOnly`). Offline message caches are stored locally on your device with file protection enabled and excluded from cloud backups.
- **Demo Mode**: When using Demo Mode, all sample messages and interactions run entirely on-device with zero network requests.
- **Remote images**: Remote images in HTML emails are blocked by default until you explicitly allow them.

## Data deletion

Signing out of lmail revokes your session on your server and deletes your local session token and offline cache from the device.

## Contact

For privacy questions, open an issue at [github.com/luka-loehr/luka-mail/issues](https://github.com/luka-loehr/luka-mail/issues) or email [luka@lukaloehr.com](mailto:luka@lukaloehr.com).
