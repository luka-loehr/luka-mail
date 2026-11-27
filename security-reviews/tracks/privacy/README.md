# Privacy track

Repository: `luka-loehr/luka-mail`

## Review questions

- Remote tracking protection: HTML email rendering blocks remote `<img>`, CSS `url(...)`, fonts, frames, and resource-hint `<link>` / `<meta refresh>` network beacons when `allowRemoteImages == false`.
- Third-party network calls: document and bound any outbound lookups performed by the self-hosted Worker (DNS-over-HTTPS, BIMI/domain icons, Gravatar/Libravatar hash lookups, APNs) accurately in `docs/PRIVACY.md` and `SECURITY.md`.
- Client IP & audit minimization: client IPs are stored only as peppered SHA-256 digests (`AUDIT_IP_PEPPER`) and pruned after 180 days; local device caches and Keychain items are wiped on sign-out.
