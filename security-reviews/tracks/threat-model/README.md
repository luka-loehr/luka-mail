# Threat model track

Repository: `luka-loehr/luka-mail`

## Review questions

- Inbound sender spoofing: unauthenticated `From:` headers vs `Authentication-Results` DMARC alignment (`inbound.ts`, `bimi.ts`, `spam.ts`) — can forged `From:` bypass spam triage, trigger APNs alerts, or poison contacts?
- Prompt injection & untrusted MIME bodies: Clef triage (`triage.ts`), reply drafts (`reply-drafts.ts`), and daily brief (`brief.ts`) — can inbound mail send, forward, delete, or exceed `dailyCapUsd`?
- Native callback & browser surface: custom-scheme `lmail://auth/callback` PKCE S256 protection against authorization-code interception and CSRF (`state`).
