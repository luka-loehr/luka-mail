# Browser and WebView review harness

Status: binding. Applies to HTML surfaces in `luka-loehr/luka-mail`: the Worker's WebAuthn passkey authorization pages (`src/worker/native-auth.ts`) and the Apple clients' sandboxed HTML email renderers (`MailHTMLDocument.swift`, `MailWebView.swift`, `SenderAvatar.swift`).

## Surfaces in scope

1. **`GET /auth/native/authorize` HTML page**:
   - Dynamic SHA-256 script-hash CSP (`auth.ts`), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `base-uri 'none'`, HTML/JSON script-context escaping (`safeScriptJson`, `escapeHtml`), and strict callback scheme validation (`lmail://auth/callback`, `lukamail://auth/callback`).
2. **Apple `MailHTMLDocument` & `MailWebView` (iOS + macOS)**:
   - `WKWebViewConfiguration` with `.nonPersistent()` data store and `allowsContentJavaScript = false`.
   - Isolated `.defaultClient` content world for height measurement (`lmHeight`).
   - Strict `<meta http-equiv="Content-Security-Policy">` blocking scripts, frames, objects, forms, fonts, and remote images when `allowRemoteImages == false`, plus stripping of resource-hint `<link>` / `<meta http-equiv="refresh">` / `<base>` tags that could leak network metadata.
   - Navigation delegate cancelling all non-`about:` frame loads and routing user taps through `MailLinkAction.forActivatedLink` (`http`, `https`, `mailto`, `tel`, `facetime`, `maps` only).

## Crafted payloads

Test crafted HTML/SVG/CSS payloads (`<script>`, inline event handlers, `<foreignObject>`, `<link rel="dns-prefetch">`, `<meta http-equiv="refresh">`, `javascript:` URLs, malformed `cid:` tokens) exclusively in local Vitest and Swift Testing suites (`MailHTMLDocumentTests.swift`, `bimi.test.ts`, `native-auth.test.ts`).
