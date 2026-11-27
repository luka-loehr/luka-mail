# App Store & Apple Apps Guide

lmail ships native SwiftUI apps for **iOS 26 / iPadOS 26** and **macOS 26** from a single XcodeGen spec (`ios/project.yml`).

## Building from source

1. Install Xcode 26+ and [XcodeGen](https://github.com/yonaskolb/XcodeGen).
2. Copy the local signing template and fill in your Apple Developer Team ID and bundle identifier:

```bash
cp ios/Config/Local.xcconfig.example ios/Config/Local.xcconfig
```

`ios/Config/Local.xcconfig` is gitignored so personal team IDs and bundle identifiers stay out of version control.

3. Generate the Xcode project and run tests:

```bash
cd ios
xcodegen generate --spec project.yml
xcodebuild -project LukaMail.xcodeproj -scheme LukaMailMac -destination 'platform=macOS' test
xcodebuild -project LukaMail.xcodeproj -scheme LukaMail -destination 'platform=iOS Simulator,name=iPhone 17 Pro' test
```

## First-launch onboarding & Demo Mode

- **Server URL setup**: On first launch, the Welcome screen prompts for your self-hosted lmail server hostname (for example, `mail.example.com`) and authenticates via WebAuthn passkey + PKCE in the system browser (`lmail://auth/callback`).
- **Demo Mode**: Tapping **Try Demo Mailbox** on the Welcome screen starts an on-device demo server (`DemoMailServer`) populated with synthetic messages, threads, drafts, and contacts. No account or backend server is required, making the app immediately testable for new users and Apple App Review. You can exit Demo Mode anytime from Settings.

## Push notifications: self-built vs App Store builds

Apple Push Notification service (APNs) binds each device token to the signing team and bundle identifier that built the app:

- **Self-built installs** (recommended for self-hosters): Set your own `LMAIL_BUNDLE_IDENTIFIER` and `DEVELOPMENT_TEAM` in `ios/Config/Local.xcconfig`, set `APNS_TOPIC` in `wrangler.jsonc` to the same bundle ID, and upload `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_PRIVATE_KEY` as Worker secrets. Your Worker delivers push alerts directly to APNs with zero intermediaries.
- **App Store builds**: Because an App Store binary is signed by the publisher's Apple Developer Team, third-party self-hosted Workers cannot sign APNs tokens for that bundle ID directly. App Store installs work out of the box with foreground incremental delta sync and background refresh; optional instant push for App Store installs can be paired with a minimal stateless wake-up relay in a future release without exposing message bodies.

## App Store Connect checklist

- **Display name**: `lmail` (avoids clashing with Apple's built-in Mail app).
- **Export compliance**: `ITSAppUsesNonExemptEncryption` is set to `false` in both iOS and macOS `Info.plist` files (standard HTTPS/TLS only).
- **macOS Sandbox**: App Sandbox (`com.apple.security.app-sandbox`), outgoing network (`com.apple.security.network.client`), and user-selected read-only files (`com.apple.security.files.user-selected.read-only`) are already enabled.
- **App Review notes**: Tell reviewers they can tap **Try Demo Mailbox** on the Welcome screen to explore all features without deploying a Cloudflare Worker.
- **Privacy & Support URLs**: Publish [docs/PRIVACY.md](./PRIVACY.md) and [docs/SUPPORT.md](./SUPPORT.md) (or host them on your site) and link them in App Store Connect.
