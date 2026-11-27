# Operations track

Repository: `luka-loehr/luka-mail`

## Review questions

- Durable delivery & queues: inbound idempotency, retry + DLQ consumer (`lmail-inbound-dlq`), outbound `send_requests` / `send_recipients` reservation before provider send, and ambiguous outcome preservation (`unknown` never auto-resent).
- Scheduled maintenance (`maintenance.ts`): stale inbound recovery, stale outbound marking, expired challenge/code/session pruning, 180-day audit retention, and `mailbox_changes` / `ai_runs` growth bounds.
- Observability & doctor checks: `GET /v1/doctor` and `GET /v1/deliverability` accuracy without leaking bearer secrets or private payloads.
