# Cryptographic implementation track

Repository: `luka-loehr/luka-mail`

## Review questions

- API key & session storage: `API_KEY_PEPPER` domain separation between `lm_live_` (`${pepper}:${secret}`) and `lm_device_` (`device-v2:${pepper}:device:${secret}`), SHA-256 hashed session/code tokens, and `crypto.subtle.timingSafeEqual` constant-time verification (`auth.ts`, `native-auth.ts`).
- WebAuthn & PKCE: `@simplewebauthn/server` `requireUserPresence` + `requireUserVerification`, atomic single-use challenge consumption, optimistic concurrency replay guard (`claimWebAuthnAssertion`), 256-bit state, and S256 PKCE verifier validation.
- APNs JWT signing: ES256 (`P-256` + `SHA-256`) provider token generation in `push.ts`.
