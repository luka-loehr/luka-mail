# Browser run: <run-id>

Target: local wrangler dev (`http://127.0.0.1:8790`) | production (passive only)
Login path: test inbox OTP | owner hand-off | logged out (see BROWSER_REVIEW_HARNESS.md)
Release under test: inkside <sha> (local build) | production version <id>

| Page | iPad portrait 820x1180 | iPad landscape 1180x820 | Phone 390x844 | Desktop 1440x900 | Dark | Console errors | CSP violations | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /en | pass / finding / blocked | | | | | 0 | 0 | |

Consent states covered: no choice, rejected, accepted (analytics and ads requests per state).

Cleanup: session signed out, test fonts and library entries removed from local state, local D1/R2 reset or retained on purpose (checked at <time>).
