#!/usr/bin/env node
// Generates openapi/openapi.json — the single OpenAPI 3.1.0 contract for lmail.
// Every operation, parameter, and schema property carries human-readable text,
// explicit bounds matching src/worker/api.ts / passkeys.ts / native-auth.ts,
// and wire examples. Enforced in CI by scripts/check-openapi.mjs and
// tests/openapi-contract.test.ts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_PATH = path.join(ROOT, "openapi", "openapi.json");

const ref = (kind, name) => ({ $ref: `#/components/${kind}/${name}` });
const schemaRef = (name) => ref("schemas", name);
const paramRef = (name) => ref("parameters", name);
const respRef = (name) => ref("responses", name);

const jsonContent = (schema, example) => ({
  "application/json": {
    schema,
    ...(example !== undefined ? { example } : {}),
  },
});

const jsonBody = (description, schema, example, required = true) => ({
  description,
  required,
  content: jsonContent(schema, example),
});

const jsonResponse = (description, schema, example) => ({
  description,
  content: jsonContent(schema, example),
});

const errorResponses = (...codes) => {
  const map = {
    400: respRef("BadRequest"),
    401: respRef("Unauthorized"),
    403: respRef("Forbidden"),
    404: respRef("NotFound"),
    409: respRef("Conflict"),
    413: respRef("PayloadTooLarge"),
    428: respRef("PreconditionRequired"),
    429: respRef("RateLimited"),
    500: respRef("InternalError"),
  };
  return Object.fromEntries(codes.map((code) => [String(code), map[code]]));
};

const apiSecurity = [{ BearerApiKey: [] }, { NativeSession: [] }, { WebSessionCookie: [] }];
const adminSecurity = [
  { BearerApiKey: [], AdminConfirmation: [] },
  { WebSessionCookie: [], AdminConfirmation: [] },
];

export function buildOpenApiSpec() {
  return {
    openapi: "3.1.0",
    info: {
      title: "lmail HTTP API",
      version: "2.0.0",
      summary: "Self-hosted Cloudflare-native email API with WebAuthn passkeys, PKCE native sessions, and Clef inbox autopilot.",
      description:
        "Canonical OpenAPI 3.1.0 contract for the lmail Cloudflare Worker, Rust CLI, and native iOS/macOS clients. Every `/v1/*` route requires authentication and enforces per-key scopes, mailbox identity allowlists, edge rate limits, and 7 MiB body limits.",
      license: {
        name: "Apache-2.0",
        url: "https://www.apache.org/licenses/LICENSE-2.0",
      },
    },
    servers: [
      {
        url: "https://{mailHost}",
        description: "Self-hosted lmail Cloudflare Worker custom domain.",
        variables: {
          mailHost: {
            default: "mail.example.com",
            description: "Configured `MAIL_HOST` custom domain serving the Worker.",
          },
        },
      },
    ],
    tags: [
      { name: "Public", description: "Unauthenticated service discovery, health, OpenAPI contract, and MTA-STS policy endpoints." },
      { name: "Auth", description: "WebAuthn passkey enrollment, browser sessions, and PKCE S256 native authorization for iOS and macOS." },
      { name: "Account", description: "Authenticated principal inspection, system diagnostics, deliverability telemetry, and audit logs." },
      { name: "Mail", description: "Mailbox summaries, incremental revision delta sync, messages, raw RFC 822 download, attachments, APNs push registration, and durable idempotent sending." },
      { name: "Drafts & Contacts", description: "Saved message drafts and per-mailbox trusted correspondent address books." },
      { name: "Autopilot & External", description: "Clef inbox triage rules, undoable autopilot action log, reply drafting, daily brief, and IMAP/SMTP account sync." },
      { name: "Administration", description: "Managed domain routing identities and scoped API key lifecycle requiring explicit administrator confirmation." },
    ],
    components: {
      securitySchemes: {
        BearerApiKey: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "lm_live_<id>_<secret>",
          description: "Scoped static API key (`lm_live_...`) or one-year device key (`lm_device_...`) sent in the `Authorization: Bearer` header.",
        },
        NativeSession: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "43-char base64url token",
          description: "30-day opaque native session token issued via WebAuthn passkey + PKCE S256 (`POST /auth/native/token`).",
        },
        WebSessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Host-lmail-session",
          description: "12-hour `HttpOnly; Secure; SameSite=Strict` passkey session cookie; non-safe methods enforce same-origin `Origin` checks.",
        },
        AdminConfirmation: {
          type: "apiKey",
          in: "header",
          name: "X-Admin-Confirmation",
          description: "Must equal `user-approved` (`lmail --confirm-admin`) for administrative address and API key mutations.",
        },
      },
      parameters: {
        IdentityQuery: {
          name: "identity",
          in: "query",
          required: false,
          description: "Optional mailbox email address narrowing the operation to a single allowlisted identity.",
          schema: schemaRef("EmailAddress"),
          example: "owner@example.com",
        },
        RequiredIdentityQuery: {
          name: "identity",
          in: "query",
          required: true,
          description: "Exact mailbox email address required for the operation.",
          schema: schemaRef("EmailAddress"),
          example: "owner@example.com",
        },
        CursorQuery: {
          name: "cursor",
          in: "query",
          required: false,
          description: "Opaque pagination cursor returned as `nextCursor` by the previous page.",
          schema: { type: "string", minLength: 1, maxLength: 256, description: "Opaque pagination cursor." },
        },
        MessageIdPath: {
          name: "id",
          in: "path",
          required: true,
          description: "Stable message identifier.",
          schema: { type: "string", minLength: 1, maxLength: 64, description: "Message identifier." },
          example: "msg_0192f0c8",
        },
        AttachmentIdPath: {
          name: "id",
          in: "path",
          required: true,
          description: "Stable attachment identifier.",
          schema: { type: "string", minLength: 1, maxLength: 64, description: "Attachment identifier." },
          example: "att_84b9d12f",
        },
        DraftIdPath: {
          name: "id",
          in: "path",
          required: true,
          description: "Draft identifier (`1..64` ASCII `[A-Za-z0-9._:-]`).",
          schema: { type: "string", minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._:-]+$", description: "Draft identifier." },
          example: "draft-01",
        },
        AddressPath: {
          name: "address",
          in: "path",
          required: true,
          description: "URL-encoded email address.",
          schema: schemaRef("EmailAddress"),
          example: "sam@example.com",
        },
        RuleIdPath: {
          name: "id",
          in: "path",
          required: true,
          description: "Autopilot rule identifier.",
          schema: { type: "string", minLength: 1, maxLength: 64, description: "Autopilot rule identifier." },
          example: "default-newsletter",
        },
        ActionIdPath: {
          name: "id",
          in: "path",
          required: true,
          description: "Full autopilot action UUID or unique 8+ character prefix shown in the daily brief.",
          schema: { type: "string", minLength: 8, maxLength: 64, pattern: "^[A-Za-z0-9-]{8,64}$", description: "Action UUID or 8+ character prefix." },
          example: "9c4b18e2",
        },
        KeyIdPath: {
          name: "id",
          in: "path",
          required: true,
          description: "16-character API key identifier.",
          schema: { type: "string", minLength: 1, maxLength: 64, description: "API key identifier." },
          example: "k9f2m4x8p1q7z3w5",
        },
      },
      responses: {
        BadRequest: jsonResponse("Request body is invalid JSON, fails schema validation, or carries an invalid parameter.", schemaRef("ErrorResponse"), {
          error: "Invalid request",
          code: "invalid_request",
          retryable: false,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        Unauthorized: jsonResponse("Missing, malformed, expired, or revoked credential.", schemaRef("ErrorResponse"), {
          error: "Authentication required",
          code: "unauthorized",
          retryable: false,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        Forbidden: jsonResponse("Caller lacks required scope, mailbox allowlist membership, owner access, or same-origin header.", schemaRef("ErrorResponse"), {
          error: "Insufficient scope",
          code: "forbidden",
          retryable: false,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        NotFound: jsonResponse("Target resource does not exist or belongs to a mailbox outside the caller's allowlist.", schemaRef("ErrorResponse"), {
          error: "Message not found",
          code: "not_found",
          retryable: false,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        Conflict: jsonResponse("State conflict (reused idempotency key with different payload, ambiguous prefix, or already-undone action).", schemaRef("ErrorResponse"), {
          error: "Already undone",
          code: "conflict",
          retryable: false,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        PayloadTooLarge: jsonResponse("Request body exceeds the route size cap (7 MiB on `/v1/*`, 256 KiB on `/auth/*`).", schemaRef("ErrorResponse"), {
          error: "Request body exceeds 7 MiB",
          code: "payload_too_large",
          retryable: false,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        PreconditionRequired: jsonResponse("Administrative mutation is missing `X-Admin-Confirmation: user-approved`.", schemaRef("ErrorResponse"), {
          error: "Explicit user confirmation is required for this administrative mutation",
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        RateLimited: jsonResponse("Edge IP, API key, send, or admin rate limit exceeded (`Retry-After: 60`).", schemaRef("ErrorResponse"), {
          error: "Rate limit exceeded",
          code: "rate_limited",
          retryable: true,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
        InternalError: jsonResponse("Unhandled server error; diagnostic details are recorded only in Workers Logs.", schemaRef("ErrorResponse"), {
          error: "Internal server error",
          code: "internal_error",
          retryable: true,
          requestId: "8f3c2e10-9a4b-4d12-8c77-123456789abc",
        }),
      },
      schemas: {
        EmailAddress: {
          type: "string",
          format: "email",
          minLength: 3,
          maxLength: 254,
          description: "Lowercase RFC 5321/5322 email address.",
          examples: ["owner@example.com"],
        },
        ErrorResponse: {
          type: "object",
          required: ["error"],
          description: "Standard JSON error envelope returned across `/auth` and `/v1` routes.",
          properties: {
            error: { type: "string", description: "Human-readable summary of what failed." },
            code: { type: "string", description: "Machine-readable error code (`invalid_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `payload_too_large`, `rate_limited`, `internal_error`)." },
            retryable: { type: "boolean", description: "Whether retrying the same request later may succeed." },
            requestId: { type: "string", description: "Per-request correlation UUID echoed in `X-Request-Id`." },
            details: { description: "Optional structured validation or domain diagnostic details." },
          },
        },
        AuthPrincipal: {
          type: "object",
          required: ["keyId", "name", "scopes", "allowedIdentities"],
          description: "Authenticated API key or passkey session principal.",
          properties: {
            keyId: { type: "string", description: "Backing API key identifier." },
            name: { type: "string", description: "Human-readable credential label." },
            scopes: { type: "array", description: "Granted permission scopes.", items: { type: "string", description: "Scope identifier." } },
            allowedIdentities: {
              type: ["array", "null"],
              description: "Explicit list of accessible mailbox addresses, or `null` for an unrestricted key.",
              items: schemaRef("EmailAddress"),
            },
          },
        },
        MailSummary: {
          type: "object",
          required: ["unread", "inbox", "sent", "starred", "archive", "trash", "drafts", "spam"],
          description: "Per-folder message and draft counters across accessible mailboxes.",
          properties: {
            unread: { type: "integer", minimum: 0, description: "Unread non-spam messages in `inbox`." },
            inbox: { type: "integer", minimum: 0, description: "Non-spam messages in `inbox`." },
            sent: { type: "integer", minimum: 0, description: "Sent messages." },
            starred: { type: "integer", minimum: 0, description: "Starred non-trash, non-spam messages." },
            archive: { type: "integer", minimum: 0, description: "Archived messages." },
            trash: { type: "integer", minimum: 0, description: "Trashed messages." },
            drafts: { type: "integer", minimum: 0, description: "Saved drafts." },
            spam: { type: "integer", minimum: 0, description: "Messages hidden by spam triage outside `trash`." },
          },
        },
        MailParticipant: {
          type: "object",
          required: ["address"],
          description: "Email participant with optional display name and deterministic avatar color.",
          properties: {
            name: { type: "string", description: "Display name, or empty string when absent." },
            address: schemaRef("EmailAddress"),
            avatarColor: { type: "string", description: "Deterministic hex color for UI avatars." },
          },
        },
        MessageTriage: {
          type: ["object", "null"],
          description: "Clef dual-model triage metadata, or `null` when untriaged.",
          properties: {
            category: {
              type: "string",
              enum: ["personal", "school", "agent", "notification", "code", "receipt", "newsletter", "spam"],
              description: "Predicted mail category.",
            },
            confidence: { type: ["number", "null"], minimum: 0, maximum: 1, description: "Averaged category probability (`0..1`)." },
            needsReply: { type: "boolean", description: "True when `triage_needs_reply >= 0.5`." },
            urgency: { type: ["integer", "null"], minimum: 0, maximum: 3, description: "Time-criticality score from `0` (none) to `3` (immediate)." },
          },
        },
        MessageSummary: {
          type: "object",
          required: [
            "id", "threadId", "direction", "folder", "subject", "sender", "recipients", "preview",
            "receivedAt", "unread", "starred", "hasAttachments", "attachmentCount", "storedAttachmentCount",
            "attachmentsTruncated", "size", "spam", "triage",
          ],
          description: "List-level representation of a ready email message.",
          properties: {
            id: { type: "string", description: "Stable message ID." },
            threadId: { type: "string", description: "Conversation thread ID." },
            direction: { type: "string", enum: ["inbound", "outbound"], description: "Whether the mail was received or sent." },
            folder: { type: "string", enum: ["inbox", "sent", "archive", "trash"], description: "Current storage folder." },
            subject: { type: "string", maxLength: 998, description: "Cleaned message subject." },
            sender: schemaRef("MailParticipant"),
            recipients: { type: "array", description: "`To` recipients.", items: schemaRef("MailParticipant") },
            preview: { type: "string", maxLength: 240, description: "Single-line plain-text snippet." },
            receivedAt: { type: "string", format: "date-time", description: "ISO 8601 message timestamp." },
            unread: { type: "boolean", description: "Unread flag." },
            starred: { type: "boolean", description: "Starred flag." },
            hasAttachments: { type: "boolean", description: "True when at least one attachment is present." },
            attachmentCount: { type: "integer", minimum: 0, description: "Total MIME attachments in the original message." },
            storedAttachmentCount: { type: "integer", minimum: 0, maximum: 50, description: "Attachments stored in R2 (capped at 50)." },
            attachmentsTruncated: { type: "boolean", description: "True when `storedAttachmentCount < attachmentCount`." },
            size: { type: "integer", minimum: 0, maximum: 10485760, description: "Raw RFC 822 size in bytes (max 10 MiB inbound)." },
            spam: { type: "boolean", description: "Spam flag." },
            triage: schemaRef("MessageTriage"),
          },
        },
        AttachmentMetadata: {
          type: "object",
          required: ["id", "filename", "contentType", "contentId", "size", "disposition"],
          description: "Stored MIME attachment metadata.",
          properties: {
            id: { type: "string", description: "Attachment ID." },
            filename: { type: "string", maxLength: 255, description: "Sanitized attachment filename." },
            contentType: { type: "string", maxLength: 127, description: "MIME content type." },
            contentId: { type: ["string", "null"], description: "Optional inline `Content-ID` for `cid:` images." },
            size: { type: "integer", minimum: 0, description: "Byte length stored in R2." },
            disposition: { type: "string", description: "`attachment` or `inline`." },
          },
        },
        MessageDetail: {
          allOf: [
            schemaRef("MessageSummary"),
            {
              type: "object",
              required: ["cc", "text", "html", "attachments", "thread", "threadTruncated"],
              description: "Full message detail with bodies, attachments, and up to 100 thread messages.",
              properties: {
                messageId: { type: ["string", "null"], description: "RFC 5322 `Message-ID` header." },
                inReplyTo: { type: ["string", "null"], description: "RFC 5322 `In-Reply-To` header." },
                cc: { type: "array", description: "`Cc` recipients.", items: schemaRef("MailParticipant") },
                text: { type: ["string", "null"], description: "Plain-text body (up to 5 MiB API cap)." },
                html: { type: ["string", "null"], description: "HTML body (up to 5 MiB API cap; rendered sandboxed by clients)." },
                attachments: { type: "array", description: "Stored attachments.", items: schemaRef("AttachmentMetadata") },
                thread: { type: "array", maxItems: 100, description: "Chronological messages in the same thread.", items: schemaRef("MessageSummary") },
                threadTruncated: { type: "boolean", description: "True when the thread exceeds 100 messages." },
              },
            },
          ],
          description: "Full message detail response.",
        },
        Draft: {
          type: "object",
          required: ["id", "from", "replyToMessageId", "to", "cc", "bcc", "subject", "text", "updatedAt"],
          description: "Saved outbound draft.",
          properties: {
            id: { type: "string", minLength: 1, maxLength: 64, description: "Draft identifier." },
            from: schemaRef("EmailAddress"),
            replyToMessageId: { type: ["string", "null"], description: "Target message ID when replying." },
            to: { type: "array", maxItems: 50, description: "`To` recipient addresses.", items: schemaRef("EmailAddress") },
            cc: { type: "array", maxItems: 50, description: "`Cc` recipient addresses.", items: schemaRef("EmailAddress") },
            bcc: { type: "array", maxItems: 50, description: "`Bcc` recipient addresses.", items: schemaRef("EmailAddress") },
            subject: { type: "string", maxLength: 998, description: "Draft subject." },
            text: { type: "string", maxLength: 2500000, description: "Plain-text body." },
            updatedAt: { type: "string", description: "Last modification timestamp." },
          },
        },
        Identity: {
          type: "object",
          required: ["address", "displayName", "avatarColor", "zoneId", "routingRuleId", "createdAt"],
          description: "Enabled mailbox identity.",
          properties: {
            address: schemaRef("EmailAddress"),
            displayName: { type: "string", maxLength: 100, description: "Sender display name." },
            avatarColor: { type: "string", description: "Deterministic hex avatar color." },
            zoneId: { type: "string", description: "Cloudflare Zone ID or `external`." },
            routingRuleId: { type: "string", description: "Cloudflare Email Routing rule ID." },
            createdAt: { type: "string", description: "Creation timestamp." },
          },
        },
        Contact: {
          type: "object",
          required: ["identityAddress", "address", "avatarColor", "source", "sendCount", "firstSentAt", "lastSentAt", "createdAt", "updatedAt"],
          description: "Trusted address-book correspondent (never flagged as spam).",
          properties: {
            identityAddress: schemaRef("EmailAddress"),
            address: schemaRef("EmailAddress"),
            displayName: { type: "string", maxLength: 100, description: "Optional contact display name." },
            avatarColor: { type: "string", description: "Deterministic hex avatar color." },
            source: { type: "string", enum: ["learned", "manual"], description: "How the contact was recorded." },
            sendCount: { type: "integer", minimum: 0, description: "Outbound messages sent to this address." },
            firstSentAt: { type: ["string", "null"], description: "First outbound send timestamp." },
            lastSentAt: { type: ["string", "null"], description: "Most recent outbound send timestamp." },
            createdAt: { type: "string", description: "Creation timestamp." },
            updatedAt: { type: "string", description: "Last update timestamp." },
          },
        },
        AutopilotSettings: {
          type: "object",
          required: ["enabled", "drafts", "brief", "dailyCapUsd"],
          description: "Global autopilot switches and daily Workers AI spend cap.",
          properties: {
            enabled: { type: "boolean", description: "Master switch for rules, reply drafts, and daily brief (spam triage still runs under budget)." },
            drafts: { type: "boolean", description: "Automatically draft replies for `personal` and `school` mail needing a reply." },
            brief: { type: "boolean", description: "Deliver the 07:00 daily brief message." },
            dailyCapUsd: { type: "number", minimum: 0, maximum: 20, description: "Daily Workers AI spending cap in USD." },
          },
        },
        AutopilotRule: {
          type: "object",
          required: ["id", "category", "action", "identity", "senderMatch", "maxUrgency", "minConfidence", "enabled", "createdAt", "updatedAt"],
          description: "Owner rule executed on confident non-waited-on triage verdicts.",
          properties: {
            id: { type: "string", description: "Rule ID." },
            category: { type: "string", enum: ["personal", "school", "agent", "notification", "code", "receipt", "newsletter"], description: "Target triage category." },
            action: { type: "string", enum: ["archive", "read", "star"], description: "Action applied when matched." },
            identity: { type: ["string", "null"], description: "Optional destination mailbox filter." },
            senderMatch: { type: ["string", "null"], description: "Optional exact sender address or `@domain` suffix." },
            maxUrgency: { type: "integer", minimum: 0, maximum: 3, description: "Maximum urgency (`0..3`) the rule may touch." },
            minConfidence: { type: "number", minimum: 0.5, maximum: 1, description: "Minimum category confidence (`0.5..1`)." },
            enabled: { type: "boolean", description: "Whether the rule is active." },
            createdAt: { type: "string", description: "Creation timestamp." },
            updatedAt: { type: "string", description: "Last update timestamp." },
          },
        },
        AutopilotAction: {
          type: "object",
          required: ["id", "messageId", "ruleId", "action", "detail", "draftId", "subject", "sender", "identity", "createdAt", "undoneAt"],
          description: "Reversible action recorded by the inbox autopilot.",
          properties: {
            id: { type: "string", description: "Action UUID." },
            messageId: { type: "string", description: "Affected message ID." },
            ruleId: { type: ["string", "null"], description: "Matching rule ID, or `null` for built-in spam/alert handling." },
            action: { type: "string", enum: ["archive", "read", "star", "spam", "draft"], description: "Action kind." },
            detail: { type: "string", description: "Human-readable reason and confidence." },
            draftId: { type: ["string", "null"], description: "Created draft ID for `draft` actions." },
            subject: { type: "string", description: "Message subject." },
            sender: {
              type: "object",
              required: ["name", "address"],
              description: "Message sender.",
              properties: {
                name: { type: "string", description: "Sender display name." },
                address: { type: "string", description: "Sender email address." },
              },
            },
            identity: { type: ["string", "null"], description: "Receiving mailbox identity." },
            createdAt: { type: "string", description: "Action timestamp." },
            undoneAt: { type: ["string", "null"], description: "Timestamp when undone, or `null`." },
          },
        },
        ApiKeyMetadata: {
          type: "object",
          required: ["id", "name", "scopes", "identities", "expiresAt", "revokedAt", "createdBy", "createdAt", "lastUsedAt"],
          description: "Stored API key metadata (never includes secrets or hashes).",
          properties: {
            id: { type: "string", description: "16-character key ID." },
            name: { type: "string", maxLength: 100, description: "Key label." },
            scopes: { type: "array", description: "Granted scopes.", items: { type: "string", description: "Scope name." } },
            identities: { type: ["array", "null"], description: "Allowlisted mailbox addresses, or `null` for unrestricted.", items: schemaRef("EmailAddress") },
            expiresAt: { type: ["string", "null"], description: "Optional ISO 8601 expiry timestamp." },
            revokedAt: { type: ["string", "null"], description: "Revocation timestamp, or `null`." },
            createdBy: { type: ["string", "null"], description: "Creator key ID." },
            createdAt: { type: "string", description: "Creation timestamp." },
            lastUsedAt: { type: ["string", "null"], description: "Coarse 5-minute activity timestamp." },
          },
        },
      },
    },
    paths: {
      "/": {
        get: {
          operationId: "getServiceInfo",
          tags: ["Public"],
          summary: "Describe service metadata",
          description: "Returns basic service name, mode, and API version without authentication.",
          security: [],
          responses: {
            200: jsonResponse("Service metadata.", {
              type: "object",
              required: ["service", "mode", "version", "description"],
              description: "Service descriptor.",
              properties: {
                service: { type: "string", description: "Configured `APP_NAME`." },
                mode: { type: "string", enum: ["mail-client"], description: "Operating mode." },
                version: { type: "integer", description: "API generation number." },
                description: { type: "string", description: "Short service summary." },
              },
            }, { service: "lmail", mode: "mail-client", version: 2, description: "Private mail API." }),
          },
        },
      },
      "/health": {
        get: {
          operationId: "getHealth",
          tags: ["Public"],
          summary: "Liveness probe",
          description: "Lightweight unauthenticated health check returning `ok: true` and protocol version.",
          security: [],
          responses: {
            200: jsonResponse("Worker is alive.", {
              type: "object",
              required: ["ok", "service", "mode", "version"],
              description: "Health status.",
              properties: {
                ok: { type: "boolean", description: "Always `true` when reachable." },
                service: { type: "string", description: "Configured `APP_NAME`." },
                mode: { type: "string", description: "Worker mode (`mail-client`)." },
                version: { type: "integer", description: "Protocol version (`2`)." },
              },
            }, { ok: true, service: "lmail", mode: "mail-client", version: 2 }),
          },
        },
      },
      "/openapi.json": {
        get: {
          operationId: "getOpenApiSpec",
          tags: ["Public"],
          summary: "Fetch OpenAPI 3.1 contract",
          description: "Serves the canonical OpenAPI 3.1.0 JSON specification for this lmail Worker.",
          security: [],
          responses: {
            200: jsonResponse("OpenAPI 3.1.0 document.", {
              type: "object",
              required: ["openapi", "info", "paths"],
              description: "OpenAPI 3.1.0 specification object.",
              properties: {
                openapi: { type: "string", description: "OpenAPI version (`3.1.0`)." },
                info: { type: "object", description: "API metadata." },
                paths: { type: "object", description: "API path operations." },
              },
            }),
          },
        },
      },
      "/.well-known/mta-sts.txt": {
        get: {
          operationId: "getMtaStsPolicy",
          tags: ["Public"],
          summary: "Fetch RFC 8461 MTA-STS policy",
          description: "Served exclusively on managed `mta-sts.<domain>` hostnames; all other paths on `mta-sts.*` hosts are isolated and return 404.",
          security: [],
          responses: {
            200: {
              description: "Enforced STSv1 policy listing Cloudflare Email Routing MX hosts.",
              content: {
                "text/plain": {
                  schema: { type: "string", description: "RFC 8461 MTA-STS policy text." },
                  example: "version: STSv1\nmode: enforce\nmx: route1.mx.cloudflare.net\nmx: route2.mx.cloudflare.net\nmx: route3.mx.cloudflare.net\nmax_age: 604800\n",
                },
              },
            },
            404: respRef("NotFound"),
          },
        },
      },
      "/auth/status": {
        get: {
          operationId: "getAuthStatus",
          tags: ["Auth"],
          summary: "Inspect web session and passkey enrollment status",
          description: "Reports whether the browser cookie is authenticated and whether initial passkey enrollment is still required.",
          security: [],
          responses: {
            200: jsonResponse("Current session and setup state.", {
              type: "object",
              required: ["authenticated", "setupRequired", "principal"],
              description: "Auth status payload.",
              properties: {
                authenticated: { type: "boolean", description: "True when `__Host-lmail-session` is valid." },
                setupRequired: { type: "boolean", description: "True when zero passkeys are enrolled." },
                principal: { oneOf: [schemaRef("AuthPrincipal"), { type: "null" }], description: "Active session principal or `null`." },
              },
            }, { authenticated: false, setupRequired: false, principal: null }),
            429: respRef("RateLimited"),
          },
        },
      },
      "/auth/passkeys/register/options": {
        post: {
          operationId: "createPasskeyRegistrationOptions",
          tags: ["Auth"],
          summary: "Begin WebAuthn passkey registration",
          description: "Creates a 5-minute WebAuthn registration challenge bound to the caller's unrestricted administrator API key (`keys:write` + `X-Admin-Confirmation: user-approved`).",
          security: [{ BearerApiKey: [], AdminConfirmation: [] }],
          responses: {
            200: jsonResponse("WebAuthn creation options and challenge ID.", {
              type: "object",
              required: ["challengeId", "options"],
              description: "Passkey registration challenge.",
              properties: {
                challengeId: { type: "string", minLength: 20, maxLength: 128, description: "Single-use challenge identifier." },
                options: { type: "object", description: "WebAuthn `PublicKeyCredentialCreationOptionsJSON`." },
              },
            }),
            ...errorResponses(400, 401, 403, 428, 429),
          },
        },
      },
      "/auth/passkeys/register/verify": {
        post: {
          operationId: "verifyPasskeyRegistration",
          tags: ["Auth"],
          summary: "Complete WebAuthn passkey registration",
          description: "Consumes a single-use registration challenge and stores the verified WebAuthn credential against the calling unrestricted administrator API key.",
          security: [{ BearerApiKey: [], AdminConfirmation: [] }],
          requestBody: jsonBody("Passkey attestation payload.", {
            type: "object",
            required: ["challengeId", "response"],
            description: "Registration verification input.",
            properties: {
              challengeId: { type: "string", minLength: 20, maxLength: 128, description: "Challenge ID from `/auth/passkeys/register/options`." },
              name: { type: "string", minLength: 1, maxLength: 80, default: "Passkey", description: "Friendly label for the enrolled passkey." },
              response: { type: "object", description: "Browser `RegistrationResponseJSON`." },
            },
          }, { challengeId: "ch_register_0123456789abcdef", name: "Primary Passkey", response: { id: "cred_1" } }),
          responses: {
            200: jsonResponse("Passkey enrolled.", {
              type: "object",
              required: ["registered"],
              description: "Enrollment confirmation.",
              properties: { registered: { type: "boolean", description: "Always `true` on success." } },
            }, { registered: true }),
            ...errorResponses(400, 401, 403, 413, 428, 429),
          },
        },
      },
      "/auth/passkeys/login/options": {
        post: {
          operationId: "createPasskeyLoginOptions",
          tags: ["Auth"],
          summary: "Begin WebAuthn browser session sign-in",
          description: "Generates a 5-minute WebAuthn authentication challenge for enrolled passkeys.",
          security: [],
          responses: {
            200: jsonResponse("WebAuthn assertion options.", {
              type: "object",
              required: ["challengeId", "options"],
              description: "Passkey login challenge.",
              properties: {
                challengeId: { type: "string", minLength: 20, maxLength: 128, description: "Single-use login challenge ID." },
                options: { type: "object", description: "WebAuthn `PublicKeyCredentialRequestOptionsJSON`." },
              },
            }),
            ...errorResponses(400, 409, 429),
          },
        },
      },
      "/auth/passkeys/login/verify": {
        post: {
          operationId: "verifyPasskeyLogin",
          tags: ["Auth"],
          summary: "Complete WebAuthn browser session sign-in",
          description: "Verifies a passkey assertion, advances the replay-protected counter atomically, and sets `__Host-lmail-session`.",
          security: [],
          requestBody: jsonBody("Passkey assertion payload.", {
            type: "object",
            required: ["challengeId", "response"],
            description: "Login verification input.",
            properties: {
              challengeId: { type: "string", minLength: 20, maxLength: 128, description: "Challenge ID from `/auth/passkeys/login/options`." },
              response: { type: "object", description: "Browser `AuthenticationResponseJSON`." },
            },
          }, { challengeId: "ch_login_0123456789abcdef", response: { id: "cred_1" } }),
          responses: {
            200: jsonResponse("Session cookie issued.", {
              type: "object",
              required: ["authenticated"],
              description: "Authentication result.",
              properties: { authenticated: { type: "boolean", description: "True once authenticated." } },
            }, { authenticated: true }),
            ...errorResponses(400, 401, 409, 413, 429),
          },
        },
      },
      "/auth/logout": {
        post: {
          operationId: "logoutWebSession",
          tags: ["Auth"],
          summary: "End browser passkey session",
          description: "Deletes the server-side web session if present after verifying same-origin headers, and clears `__Host-lmail-session`.",
          security: [{ WebSessionCookie: [] }, {}],
          responses: {
            200: jsonResponse("Web session cleared.", {
              type: "object",
              required: ["authenticated"],
              description: "Logout confirmation.",
              properties: { authenticated: { type: "boolean", description: "Always `false`." } },
            }, { authenticated: false }),
            403: respRef("Forbidden"),
            429: respRef("RateLimited"),
          },
        },
      },
      "/auth/native/authorize": {
        get: {
          operationId: "authorizeNativeClient",
          tags: ["Auth"],
          summary: "Render native passkey authorization page",
          description: "Validates PKCE S256 parameters and approved `lmail://auth/callback` redirect URI, then renders the CSP-nonce-protected WebAuthn prompt page.",
          security: [],
          parameters: [
            {
              name: "redirect_uri",
              in: "query",
              required: true,
              description: "Approved custom-scheme callback URI (`lmail://auth/callback` or legacy `lukamail://auth/callback`).",
              schema: { type: "string", enum: ["lmail://auth/callback", "lukamail://auth/callback"], description: "Native callback URI." },
            },
            {
              name: "state",
              in: "query",
              required: true,
              description: "High-entropy base64url CSRF state (`32..128` characters).",
              schema: { type: "string", minLength: 32, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$", description: "Client state token." },
            },
            {
              name: "code_challenge",
              in: "query",
              required: true,
              description: "43-character base64url SHA-256 PKCE code challenge.",
              schema: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]{43}$", description: "PKCE S256 challenge." },
            },
            {
              name: "code_challenge_method",
              in: "query",
              required: true,
              description: "PKCE challenge method (`S256` required).",
              schema: { type: "string", enum: ["S256"], description: "PKCE method." },
            },
            {
              name: "platform",
              in: "query",
              required: true,
              description: "Initiating Apple client platform.",
              schema: { type: "string", enum: ["ios", "macos"], description: "Client platform." },
            },
          ],
          responses: {
            200: {
              description: "HTML passkey authorization page protected by per-request cryptographic CSP nonce.",
              content: { "text/html": { schema: { type: "string", description: "HTML document." } } },
            },
            400: { description: "Invalid authorization request HTML error page.", content: { "text/html": { schema: { type: "string", description: "HTML error page." } } } },
            409: { description: "No passkey enrolled HTML error page.", content: { "text/html": { schema: { type: "string", description: "HTML error page." } } } },
            429: respRef("RateLimited"),
          },
        },
      },
      "/auth/native/verify": {
        post: {
          operationId: "verifyNativePasskey",
          tags: ["Auth"],
          summary: "Verify native passkey assertion and mint one-time code",
          description: "Consumes the pending native authorization challenge, verifies the passkey assertion, and returns a single-use callback redirect URI.",
          security: [],
          requestBody: jsonBody("Native passkey assertion.", {
            type: "object",
            required: ["authorizationId", "response"],
            description: "Native verification input.",
            properties: {
              authorizationId: { type: "string", minLength: 20, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$", description: "Single-use authorization ID." },
              response: { type: "object", description: "Browser `AuthenticationResponseJSON`." },
            },
          }, { authorizationId: "auth_0123456789abcdef0123", response: { id: "cred_1" } }),
          responses: {
            200: jsonResponse("Callback redirect URI carrying one-time code and state.", {
              type: "object",
              required: ["redirectTo"],
              description: "Native callback redirect.",
              properties: { redirectTo: { type: "string", description: "`lmail://auth/callback?code=...&state=...` URI." } },
            }, { redirectTo: "lmail://auth/callback?code=abc&state=xyz" }),
            ...errorResponses(400, 401, 409, 413, 429),
          },
        },
      },
      "/auth/native/token": {
        post: {
          operationId: "exchangeNativeAuthorizationCode",
          tags: ["Auth"],
          summary: "Exchange one-time code and PKCE verifier for 30-day session",
          description: "Atomically consumes the 5-minute authorization code, verifies the PKCE S256 `codeVerifier` in constant time, and issues a 30-day native bearer token.",
          security: [],
          requestBody: jsonBody("PKCE token exchange request.", {
            type: "object",
            required: ["code", "redirectUri", "codeVerifier"],
            description: "Authorization code + PKCE verifier.",
            properties: {
              code: { type: "string", minLength: 43, maxLength: 43, pattern: "^[A-Za-z0-9_-]+$", description: "43-character single-use authorization code." },
              redirectUri: { type: "string", enum: ["lmail://auth/callback", "lukamail://auth/callback"], description: "Exact callback URI used during `/auth/native/authorize`." },
              codeVerifier: { type: "string", minLength: 43, maxLength: 128, pattern: "^[A-Za-z0-9._~-]{43,128}$", description: "RFC 7636 PKCE code verifier." },
            },
          }, {
            code: "0123456789abcdef0123456789abcdef0123456789a",
            redirectUri: "lmail://auth/callback",
            codeVerifier: "verifier_0123456789abcdef0123456789abcdef0123456",
          }),
          responses: {
            200: jsonResponse("30-day opaque native bearer session.", {
              type: "object",
              required: ["accessToken", "tokenType", "expiresIn"],
              description: "Native bearer token response.",
              properties: {
                accessToken: { type: "string", minLength: 43, maxLength: 43, description: "Opaque 43-character bearer token." },
                tokenType: { type: "string", enum: ["Bearer"], description: "Token scheme (`Bearer`)." },
                expiresIn: { type: "integer", description: "Session lifetime in seconds (`2592000` = 30 days)." },
              },
            }, { accessToken: "0123456789abcdef0123456789abcdef0123456789a", tokenType: "Bearer", expiresIn: 2592000 }),
            ...errorResponses(400, 403, 413, 429),
          },
        },
      },
      "/auth/native/logout": {
        post: {
          operationId: "revokeNativeSession",
          tags: ["Auth"],
          summary: "Revoke native bearer session",
          description: "Immediately deletes the caller's 30-day native session from D1.",
          security: [{ NativeSession: [] }],
          responses: {
            200: jsonResponse("Native session revoked.", {
              type: "object",
              required: ["revoked"],
              description: "Revocation status.",
              properties: { revoked: { type: "boolean", description: "True when the session row was removed." } },
            }, { revoked: true }),
            ...errorResponses(401, 429),
          },
        },
      },
      "/v1/whoami": {
        get: {
          operationId: "getWhoAmI",
          tags: ["Account"],
          summary: "Inspect authenticated principal",
          description: "Returns the caller's key ID, scopes, mailbox allowlist, and configured instance owner email (`account:read`).",
          security: apiSecurity,
          responses: {
            200: jsonResponse("Principal and owner email.", {
              type: "object",
              required: ["principal", "owner"],
              description: "WhoAmI payload.",
              properties: {
                principal: schemaRef("AuthPrincipal"),
                owner: schemaRef("EmailAddress"),
              },
            }, {
              principal: { keyId: "k9f2m4x8p1q7z3w5", name: "cli", scopes: ["*"], allowedIdentities: null },
              owner: "owner@example.com",
            }),
            ...errorResponses(401, 403, 429),
          },
        },
      },
      "/v1/deliverability": {
        get: {
          operationId: "getDeliverabilityReport",
          tags: ["Account"],
          summary: "Inspect domain DNS and outbound deliverability report",
          description: "Checks SPF, DKIM, DMARC, MTA-STS, TLS-RPT, and sending metrics over the requested window (`account:read` + `addresses:read`).",
          security: apiSecurity,
          parameters: [
            {
              name: "hours",
              in: "query",
              required: false,
              description: "Analytics lookback window in hours (`1..168`, default `24`).",
              schema: { type: "integer", minimum: 1, maximum: 168, default: 24, description: "Window in hours." },
            },
          ],
          responses: {
            200: jsonResponse("Deliverability telemetry and DNS verification report.", {
              type: "object",
              required: ["healthy", "windowHours", "checkedAt"],
              description: "Deliverability report.",
              properties: {
                healthy: { type: "boolean", description: "Overall deliverability health." },
                windowHours: { type: "integer", minimum: 1, maximum: 168, description: "Evaluated lookback window." },
                checkedAt: { type: "string", format: "date-time", description: "Check timestamp." },
                domains: { type: "array", description: "Per-domain DNS and sending checks.", items: { type: "object", description: "Domain report." } },
              },
            }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/doctor": {
        get: {
          operationId: "getDoctorReport",
          tags: ["Account"],
          summary: "Run end-to-end storage, queue, routing, DNS, and IMAP diagnostics",
          description: "Verifies D1 message/send health, R2 object access, queue backlog age, Cloudflare Email Routing rules, public DNS records, and external IMAP accounts (`account:read` + `addresses:read`).",
          security: apiSecurity,
          responses: {
            200: jsonResponse("Structured health report.", {
              type: "object",
              required: ["healthy", "owner", "checkedAt", "durationMs", "checks"],
              description: "Doctor diagnostic payload.",
              properties: {
                healthy: { type: "boolean", description: "True when every subsystem check passes." },
                owner: schemaRef("EmailAddress"),
                checkedAt: { type: "string", format: "date-time", description: "Report timestamp." },
                durationMs: { type: "integer", minimum: 0, description: "Diagnostic execution duration in milliseconds." },
                checks: { type: "object", description: "Subsystem check details (`database`, `objectStorage`, `queue`, `routing`, `domains`, `external`)." },
              },
            }),
            ...errorResponses(401, 403, 429),
          },
        },
      },
      "/v1/audit": {
        get: {
          operationId: "listAuditEvents",
          tags: ["Account"],
          summary: "List security audit log events",
          description: "Returns paginated 180-day audit log entries for mutations and sensitive reads (`audit:read`).",
          security: apiSecurity,
          parameters: [
            { name: "limit", in: "query", required: false, description: "Page size (`1..250`, default `100`).", schema: { type: "integer", minimum: 1, maximum: 250, default: 100, description: "Max events." } },
            paramRef("CursorQuery"),
            { name: "keyId", in: "query", required: false, description: "Filter by actor API key ID (`<= 64` chars).", schema: { type: "string", maxLength: 64, description: "Actor key ID." } },
            { name: "action", in: "query", required: false, description: "Literal substring filter on `METHOD /path` (`<= 50` UTF-8 bytes).", schema: { type: "string", maxLength: 50, description: "Action substring." } },
          ],
          responses: {
            200: jsonResponse("Audit events page.", {
              type: "object",
              required: ["events", "nextCursor"],
              description: "Paginated audit events.",
              properties: {
                events: {
                  type: "array",
                  description: "Audit log records.",
                  items: {
                    type: "object",
                    required: ["id", "requestId", "actor", "action", "resource", "status", "ipHash", "createdAt"],
                    description: "Single audit event.",
                    properties: {
                      id: { type: "string", description: "Audit event UUID." },
                      requestId: { type: "string", description: "Request correlation UUID." },
                      keyId: { type: ["string", "null"], description: "Calling API key ID." },
                      actor: { type: "string", description: "Key display name." },
                      action: { type: "string", description: "HTTP method and pathname." },
                      resource: { type: "string", description: "Target resource identifier or `-`." },
                      status: { type: "integer", description: "HTTP response status." },
                      ipHash: { type: "string", description: "Peppered SHA-256 client IP digest." },
                      userAgent: { type: ["string", "null"], description: "Truncated User-Agent (`<= 512` chars)." },
                      metadata: { description: "Edge colo/country metadata." },
                      createdAt: { type: "string", description: "Event timestamp." },
                    },
                  },
                },
                nextCursor: { type: ["string", "null"], description: "Opaque cursor for the next page, or `null`." },
              },
            }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/summary": {
        get: {
          operationId: "getMailboxSummary",
          tags: ["Mail"],
          summary: "Count unread, folder, draft, and spam totals",
          description: "Returns folder counters across accessible mailboxes (`mail:read`), supporting `ETag` / `If-None-Match` (`304`).",
          security: apiSecurity,
          parameters: [paramRef("IdentityQuery")],
          responses: {
            200: jsonResponse("Folder counters.", schemaRef("MailSummary"), {
              unread: 2, inbox: 14, sent: 42, starred: 3, archive: 120, trash: 0, drafts: 1, spam: 4,
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/push-devices": {
        put: {
          operationId: "registerPushDevice",
          tags: ["Mail"],
          summary: "Register or refresh APNs device token",
          description: "Binds a hex-encoded APNs device token to the caller's allowlisted and enabled identities (`mail:read`).",
          security: apiSecurity,
          requestBody: jsonBody("APNs registration payload.", {
            type: "object",
            required: ["deviceToken", "environment", "identities"],
            description: "APNs device registration.",
            properties: {
              deviceToken: { type: "string", minLength: 64, maxLength: 400, pattern: "^[a-f0-9]{64,400}$", description: "Lowercase hex APNs token." },
              environment: { type: "string", enum: ["development", "production"], description: "APNs environment." },
              identities: { type: "array", minItems: 1, maxItems: 100, description: "Mailboxes to receive alerts for.", items: schemaRef("EmailAddress") },
            },
          }, {
            deviceToken: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            environment: "production",
            identities: ["owner@example.com"],
          }),
          responses: {
            200: jsonResponse("Registered APNs device.", {
              type: "object",
              required: ["registered", "identities"],
              description: "Registration confirmation.",
              properties: {
                registered: { type: "boolean", description: "Always `true`." },
                identities: { type: "array", description: "Enabled mailboxes bound to this token.", items: schemaRef("EmailAddress") },
              },
            }, { registered: true, identities: ["owner@example.com"] }),
            ...errorResponses(400, 401, 403, 413, 429),
          },
        },
        delete: {
          operationId: "unregisterPushDevice",
          tags: ["Mail"],
          summary: "Remove APNs device token",
          description: "Unregisters an APNs token owned by the calling credential (`mail:read`).",
          security: apiSecurity,
          requestBody: jsonBody("APNs token removal payload.", {
            type: "object",
            required: ["deviceToken", "environment"],
            description: "APNs token identifier.",
            properties: {
              deviceToken: { type: "string", minLength: 64, maxLength: 400, pattern: "^[a-f0-9]{64,400}$", description: "Lowercase hex APNs token." },
              environment: { type: "string", enum: ["development", "production"], description: "APNs environment." },
            },
          }, {
            deviceToken: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
            environment: "production",
          }),
          responses: {
            200: jsonResponse("APNs token removed.", {
              type: "object",
              required: ["removed"],
              description: "Removal result.",
              properties: { removed: { type: "boolean", description: "Always `true`." } },
            }, { removed: true }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/mailbox-state": {
        get: {
          operationId: "getMailboxState",
          tags: ["Mail"],
          summary: "Read or long-poll mailbox revision",
          description: "Returns the current monotonic mailbox revision immediately or waits up to 25 seconds for a change after `after` (`mail:read`).",
          security: apiSecurity,
          parameters: [
            paramRef("IdentityQuery"),
            { name: "after", in: "query", required: false, description: "Last known decimal mailbox revision (`<= 20` digits).", schema: { type: "string", maxLength: 20, pattern: "^\\d+$", description: "Revision string." } },
            { name: "wait", in: "query", required: false, description: "Long-poll wait timeout in seconds (`0..25`, default `0`).", schema: { type: "integer", minimum: 0, maximum: 25, default: 0, description: "Seconds to wait." } },
          ],
          responses: {
            200: jsonResponse("Current mailbox revision.", {
              type: "object",
              required: ["revision", "changed"],
              description: "Mailbox revision state.",
              properties: {
                revision: { type: "string", description: "Current monotonic revision." },
                changed: { type: "boolean", description: "True when `after` was supplied and differs from `revision`." },
              },
            }, { revision: "42", changed: true }),
            204: { description: "Client aborted the long-poll connection before completion." },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/mailbox-delta": {
        get: {
          operationId: "getMailboxDelta",
          tags: ["Mail"],
          summary: "Fetch incremental mailbox change log since revision",
          description: "Streams contiguous message and draft upserts/deletes for a single identity since `since`, or sets `resetRequired: true` when history was pruned (`mail:read`).",
          security: apiSecurity,
          parameters: [
            paramRef("RequiredIdentityQuery"),
            { name: "since", in: "query", required: true, description: "Base mailbox revision (`<= 20` digits).", schema: { type: "string", maxLength: 20, pattern: "^\\d+$", description: "Starting revision." } },
            { name: "limit", in: "query", required: false, description: "Max changes per page (`1..250`, default `100`).", schema: { type: "integer", minimum: 1, maximum: 250, default: 100, description: "Page size." } },
            paramRef("CursorQuery"),
          ],
          responses: {
            200: jsonResponse("Ordered delta changes or snapshot reset signal.", {
              type: "object",
              required: ["fromRevision", "revision", "changes", "hasMore", "nextCursor", "resetRequired"],
              description: "Mailbox delta page.",
              properties: {
                identity: schemaRef("EmailAddress"),
                fromRevision: { type: "string", description: "Base revision requested." },
                revision: { type: "string", description: "Target revision covered." },
                changes: { type: "array", description: "Contiguous ordered change entries.", items: { type: "object", description: "Message or draft delta item." } },
                summary: schemaRef("MailSummary"),
                hasMore: { type: "boolean", description: "True when additional pages remain." },
                nextCursor: { type: ["string", "null"], description: "Opaque delta cursor or `null`." },
                resetRequired: { type: "boolean", description: "True when the client must fetch `/v1/mailbox-snapshot`." },
                reason: { type: "string", description: "Reset reason (`revision_ahead`, `history_expired`, `non_contiguous`)." },
              },
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/mailbox-snapshot": {
        get: {
          operationId: "getMailboxSnapshot",
          tags: ["Mail"],
          summary: "Fetch atomic revision, summary, first folder page, and drafts",
          description: "Single-roundtrip initial state loader for native clients (`mail:read`, plus `addresses:read` when `includeAddresses=1`).",
          security: apiSecurity,
          parameters: [
            { name: "folder", in: "query", required: false, description: "Folder to snapshot (`inbox`, `sent`, `archive`, `trash`, `starred`, `all`, `spam`, `drafts`).", schema: { type: "string", enum: ["inbox", "sent", "archive", "trash", "starred", "all", "spam", "drafts"], default: "inbox", description: "Snapshot folder." } },
            { name: "query", in: "query", required: false, description: "Optional search filter (`<= 50` UTF-8 bytes).", schema: { type: "string", maxLength: 50, description: "Search string." } },
            { name: "limit", in: "query", required: false, description: "Page size (`1..100`, default `50`).", schema: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Page size." } },
            paramRef("IdentityQuery"),
            { name: "includeAddresses", in: "query", required: false, description: "Set to `1` to include enabled identities (`addresses:read`).", schema: { type: "string", enum: ["0", "1"], default: "0", description: "Include addresses flag." } },
          ],
          responses: {
            200: jsonResponse("Mailbox snapshot.", {
              type: "object",
              required: ["revision", "summary", "messages", "nextCursor", "drafts"],
              description: "Atomic mailbox snapshot.",
              properties: {
                revision: { type: "string", description: "Current mailbox revision." },
                summary: schemaRef("MailSummary"),
                messages: { type: "array", description: "First page of messages.", items: schemaRef("MessageSummary") },
                nextCursor: { type: ["string", "null"], description: "Pagination cursor for older messages." },
                drafts: { type: "array", description: "Newest 100 saved drafts.", items: schemaRef("Draft") },
                addresses: { type: "array", description: "Enabled identities when `includeAddresses=1`.", items: schemaRef("Identity") },
              },
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/messages": {
        get: {
          operationId: "listMessages",
          tags: ["Mail"],
          summary: "List or search messages in a folder",
          description: "Returns newest-first messages in `folder` filtered by optional `query` and `identity` (`mail:read`).",
          security: apiSecurity,
          parameters: [
            { name: "folder", in: "query", required: false, description: "Target mailbox folder (`inbox`, `sent`, `archive`, `trash`, `starred`, `all`, `spam`).", schema: { type: "string", enum: ["inbox", "sent", "archive", "trash", "starred", "all", "spam"], default: "inbox", description: "Mailbox folder." } },
            { name: "query", in: "query", required: false, description: "Search substring across subject, sender, and preview (`<= 50` UTF-8 bytes).", schema: { type: "string", maxLength: 50, description: "Search query." } },
            { name: "limit", in: "query", required: false, description: "Page size (`1..100`, default `50`).", schema: { type: "integer", minimum: 1, maximum: 100, default: 50, description: "Max messages." } },
            paramRef("CursorQuery"),
            paramRef("IdentityQuery"),
          ],
          responses: {
            200: jsonResponse("Paginated message list.", {
              type: "object",
              required: ["messages", "nextCursor"],
              description: "Message page.",
              properties: {
                messages: { type: "array", description: "Matching messages.", items: schemaRef("MessageSummary") },
                nextCursor: { type: ["string", "null"], description: "Opaque cursor for the next page." },
              },
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/messages/{id}/sender-logo": {
        get: {
          operationId: "getMessageSenderLogo",
          tags: ["Mail"],
          summary: "Fetch verified BIMI or brand sender logo",
          description: "Returns a cached BIMI SVG or verified brand icon only for DMARC-authenticated inbound (or own outbound) messages (`mail:read`).",
          security: apiSecurity,
          parameters: [paramRef("MessageIdPath")],
          responses: {
            200: {
              description: "Sandboxed sender logo image bytes.",
              content: { "image/*": { schema: { type: "string", format: "binary", description: "Image payload." } } },
            },
            304: { description: "Logo unchanged since `If-None-Match`." },
            ...errorResponses(401, 403, 404, 429),
          },
        },
      },
      "/v1/logo-backfill": {
        post: {
          operationId: "backfillSenderLogos",
          tags: ["Mail"],
          summary: "Warm sender-logo cache for up to 10 messages",
          description: "Advances through ready messages in the caller's allowlist to warm verified sender logos (`mail:read`).",
          security: apiSecurity,
          parameters: [
            { name: "cursor", in: "query", required: false, description: "Last processed message ID (`<= 128` chars).", schema: { type: "string", maxLength: 128, description: "Backfill cursor." } },
          ],
          responses: {
            200: jsonResponse("Backfill batch progress.", {
              type: "object",
              required: ["processed", "nextCursor"],
              description: "Logo backfill result.",
              properties: {
                processed: { type: "integer", minimum: 0, maximum: 10, description: "Messages inspected in this call." },
                nextCursor: { type: ["string", "null"], description: "Next cursor or `null` when complete." },
              },
            }, { processed: 10, nextCursor: null }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/messages/{id}": {
        get: {
          operationId: "getMessage",
          tags: ["Mail"],
          summary: "Read message detail, bodies, attachments, and thread",
          description: "Fetches full plain-text/HTML bodies, attachment metadata, and up to 100 messages in the conversation (`mail:read`).",
          security: apiSecurity,
          parameters: [paramRef("MessageIdPath"), paramRef("IdentityQuery")],
          responses: {
            200: jsonResponse("Full message detail.", schemaRef("MessageDetail")),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
        patch: {
          operationId: "updateMessage",
          tags: ["Mail"],
          summary: "Update message read, star, folder, or spam state",
          description: "Mutates organization flags on a ready message inside the caller's allowlist (`mail:write`).",
          security: apiSecurity,
          parameters: [paramRef("MessageIdPath")],
          requestBody: jsonBody("Fields to update (at least one required).", {
            type: "object",
            minProperties: 1,
            description: "Mutable message flags.",
            properties: {
              unread: { type: "boolean", description: "Mark unread (`true`) or read (`false`)." },
              starred: { type: "boolean", description: "Star (`true`) or unstar (`false`)." },
              folder: { type: "string", enum: ["inbox", "sent", "archive", "trash"], description: "Destination folder." },
              spam: { type: "boolean", description: "Mark as spam (`true`) or not spam (`false`)." },
            },
          }, { unread: false, folder: "archive" }),
          responses: {
            200: jsonResponse("Message updated.", {
              type: "object",
              required: ["updated"],
              description: "Update confirmation.",
              properties: { updated: { type: "boolean", description: "Always `true`." } },
            }, { updated: true }),
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
      },
      "/v1/messages/{id}/raw": {
        get: {
          operationId: "getRawMessage",
          tags: ["Mail"],
          summary: "Download raw RFC 822 `.eml` message",
          description: "Streams the original `message/rfc822` object from R2 (`mail:read`, audited).",
          security: apiSecurity,
          parameters: [paramRef("MessageIdPath")],
          responses: {
            200: {
              description: "Raw RFC 822 message stream.",
              content: { "message/rfc822": { schema: { type: "string", description: "Raw RFC 822 bytes." } } },
            },
            ...errorResponses(401, 403, 404, 429),
          },
        },
      },
      "/v1/attachments/{id}": {
        get: {
          operationId: "getAttachment",
          tags: ["Mail"],
          summary: "Download message attachment",
          description: "Streams an attachment with `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff` (`mail:read`, audited).",
          security: apiSecurity,
          parameters: [paramRef("AttachmentIdPath")],
          responses: {
            200: {
              description: "Binary attachment stream.",
              content: { "application/octet-stream": { schema: { type: "string", format: "binary", description: "Attachment bytes." } } },
            },
            ...errorResponses(401, 403, 404, 429),
          },
        },
      },
      "/v1/messages/send": {
        post: {
          operationId: "sendMessage",
          tags: ["Mail"],
          summary: "Send an email durably and idempotently",
          description: "Stages per-recipient state under `idempotencyKey`, delivers via Cloudflare Email Sending or external SMTP, and records learned contacts (`mail:send`).",
          security: apiSecurity,
          requestBody: jsonBody("Outbound email payload (`<= 20` total unique recipients, `<= 5 MiB` encoded MIME).", {
            type: "object",
            required: ["idempotencyKey", "from", "to", "text"],
            description: "Send message request.",
            properties: {
              idempotencyKey: { type: "string", format: "uuid", description: "Client-generated UUID preventing duplicate sends on retry." },
              from: schemaRef("EmailAddress"),
              to: { type: "array", minItems: 1, maxItems: 20, description: "Primary recipients.", items: schemaRef("EmailAddress") },
              cc: { type: "array", maxItems: 20, default: [], description: "Carbon-copy recipients.", items: schemaRef("EmailAddress") },
              bcc: { type: "array", maxItems: 20, default: [], description: "Blind carbon-copy recipients.", items: schemaRef("EmailAddress") },
              subject: { type: "string", maxLength: 998, default: "", description: "Email subject." },
              text: { type: "string", maxLength: 2500000, description: "Plain-text body." },
              html: { type: ["string", "null"], maxLength: 2500000, description: "Optional HTML body." },
              replyToMessageId: { type: ["string", "null"], maxLength: 64, description: "Optional message ID being replied to for threading." },
              attachments: {
                type: "array",
                maxItems: 10,
                default: [],
                description: "Up to 10 base64-encoded attachments.",
                items: {
                  type: "object",
                  required: ["filename", "contentType", "data"],
                  description: "Outbound attachment.",
                  properties: {
                    filename: { type: "string", minLength: 1, maxLength: 255, description: "Attachment filename." },
                    contentType: { type: "string", minLength: 1, maxLength: 127, description: "MIME type." },
                    data: { type: "string", minLength: 1, maxLength: 6000000, description: "Standard base64-encoded bytes." },
                  },
                },
              },
            },
          }, {
            idempotencyKey: "11111111-1111-4111-8111-111111111111",
            from: "owner@example.com",
            to: ["sam@example.com"],
            subject: "Server move this weekend",
            text: "Sounds good, see you Saturday!",
          }),
          responses: {
            200: jsonResponse("Idempotent replay of an earlier completed send.", schemaRef("SendOutcome")),
            201: jsonResponse("Outbound message delivered.", schemaRef("SendOutcome")),
            ...errorResponses(400, 401, 403, 404, 409, 413, 429),
            502: jsonResponse("Provider delivery failed or remained ambiguous (`partial`, `failed`, or `unknown`).", schemaRef("ErrorResponse")),
          },
        },
      },
      "/v1/send-requests/{idempotencyKey}": {
        get: {
          operationId: "getSendRequest",
          tags: ["Mail"],
          summary: "Inspect durable send request and per-recipient delivery state",
          description: "Returns delivery state for an outbound send initiated by the same API key (`mail:send`, audited).",
          security: apiSecurity,
          parameters: [
            { name: "idempotencyKey", in: "path", required: true, description: "UUID passed to `POST /v1/messages/send`.", schema: { type: "string", format: "uuid", description: "Send idempotency UUID." } },
          ],
          responses: {
            200: jsonResponse("Durable send status.", {
              type: "object",
              required: ["idempotencyKey", "status", "recipients", "createdAt", "updatedAt"],
              description: "Send request status.",
              properties: {
                idempotencyKey: { type: "string", format: "uuid", description: "Idempotency UUID." },
                status: { type: "string", enum: ["processing", "reserved", "sending", "partial", "complete", "failed", "unknown"], description: "Aggregate send state." },
                messageId: { type: ["string", "null"], description: "RFC 5322 `Message-ID`." },
                messageRowId: { type: ["string", "null"], description: "Stored outbound message ID." },
                error: { type: ["string", "null"], description: "Failure summary when incomplete." },
                createdAt: { type: "string", description: "Creation timestamp." },
                updatedAt: { type: "string", description: "Last update timestamp." },
                recipients: { type: "array", description: "Per-recipient delivery outcomes.", items: { type: "object", description: "Recipient status." } },
              },
            }),
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
      },
      "/v1/drafts": {
        get: {
          operationId: "listDrafts",
          tags: ["Drafts & Contacts"],
          summary: "List newest 100 saved drafts",
          description: "Returns saved drafts across allowlisted mailboxes (`mail:read`).",
          security: apiSecurity,
          parameters: [paramRef("IdentityQuery")],
          responses: {
            200: jsonResponse("Draft list.", {
              type: "object",
              required: ["drafts"],
              description: "Draft collection.",
              properties: { drafts: { type: "array", maxItems: 100, description: "Saved drafts.", items: schemaRef("Draft") } },
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(400, 401, 403, 429),
          },
        },
        put: {
          operationId: "saveDraft",
          tags: ["Drafts & Contacts"],
          summary: "Create or update a draft",
          description: "Creates or overwrites a draft inside an allowlisted, enabled mailbox (`mail:write`).",
          security: apiSecurity,
          requestBody: jsonBody("Draft content.", {
            type: "object",
            required: ["from"],
            description: "Draft upsert payload.",
            properties: {
              id: { type: ["string", "null"], minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9._:-]+$", description: "Optional client-chosen draft ID." },
              from: schemaRef("EmailAddress"),
              replyToMessageId: { type: ["string", "null"], maxLength: 64, description: "Optional target message ID." },
              to: { type: "array", maxItems: 50, default: [], description: "`To` addresses.", items: schemaRef("EmailAddress") },
              cc: { type: "array", maxItems: 50, default: [], description: "`Cc` addresses.", items: schemaRef("EmailAddress") },
              bcc: { type: "array", maxItems: 50, default: [], description: "`Bcc` addresses.", items: schemaRef("EmailAddress") },
              subject: { type: "string", maxLength: 998, default: "", description: "Draft subject." },
              text: { type: "string", maxLength: 2500000, default: "", description: "Draft plain-text body." },
            },
          }, { from: "owner@example.com", to: ["sam@example.com"], subject: "Notes", text: "Draft text" }),
          responses: {
            200: jsonResponse("Draft saved.", {
              type: "object",
              required: ["saved", "id"],
              description: "Saved draft receipt.",
              properties: {
                saved: { type: "boolean", description: "Always `true`." },
                id: { type: "string", description: "Draft ID." },
              },
            }, { saved: true, id: "draft-01" }),
            ...errorResponses(400, 401, 403, 404, 413, 429),
          },
        },
      },
      "/v1/drafts/{id}": {
        delete: {
          operationId: "deleteDraft",
          tags: ["Drafts & Contacts"],
          summary: "Delete a saved draft",
          description: "Removes a draft inside the caller's mailbox allowlist (`mail:write`).",
          security: apiSecurity,
          parameters: [paramRef("DraftIdPath")],
          responses: {
            200: jsonResponse("Draft deleted.", {
              type: "object",
              required: ["deleted"],
              description: "Deletion receipt.",
              properties: { deleted: { type: "boolean", description: "Always `true`." } },
            }, { deleted: true }),
            ...errorResponses(401, 403, 404, 429),
          },
        },
      },
      "/v1/contacts": {
        get: {
          operationId: "listContacts",
          tags: ["Drafts & Contacts"],
          summary: "List or search contacts",
          description: "Returns trusted contacts ranked by match quality and send frequency (`mail:read`).",
          security: apiSecurity,
          parameters: [
            paramRef("IdentityQuery"),
            { name: "query", in: "query", required: false, description: "Name or address filter (`<= 100` UTF-8 bytes).", schema: { type: "string", maxLength: 100, description: "Contact query." } },
            { name: "limit", in: "query", required: false, description: "Max contacts (`1..200`, default `50`).", schema: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Page size." } },
          ],
          responses: {
            200: jsonResponse("Contact list.", {
              type: "object",
              required: ["contacts"],
              description: "Contacts response.",
              properties: { contacts: { type: "array", description: "Matching contacts.", items: schemaRef("Contact") } },
            }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
        post: {
          operationId: "createContact",
          tags: ["Drafts & Contacts"],
          summary: "Add or upsert a manual contact",
          description: "Saves a trusted correspondent in the mailbox's address book so their mail is never flagged as spam (`mail:write`).",
          security: apiSecurity,
          requestBody: jsonBody("Contact creation payload.", {
            type: "object",
            required: ["identity", "address"],
            description: "Contact upsert input.",
            properties: {
              identity: schemaRef("EmailAddress"),
              address: schemaRef("EmailAddress"),
              displayName: { type: "string", maxLength: 100, default: "", description: "Contact display name (no control characters)." },
            },
          }, { identity: "owner@example.com", address: "sam@example.com", displayName: "Sam Patel" }),
          responses: {
            201: jsonResponse("Contact created.", {
              type: "object",
              required: ["created", "contact"],
              description: "Created contact response.",
              properties: {
                created: { type: "boolean", description: "Always `true`." },
                contact: schemaRef("Contact"),
              },
            }),
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
      },
      "/v1/contacts/{address}": {
        patch: {
          operationId: "updateContact",
          tags: ["Drafts & Contacts"],
          summary: "Rename an existing contact",
          description: "Updates the display name of an address-book contact (`mail:write`).",
          security: apiSecurity,
          parameters: [paramRef("AddressPath")],
          requestBody: jsonBody("Contact update payload.", {
            type: "object",
            required: ["identity", "displayName"],
            description: "Contact rename input.",
            properties: {
              identity: schemaRef("EmailAddress"),
              displayName: { type: "string", maxLength: 100, description: "Updated display name." },
            },
          }, { identity: "owner@example.com", displayName: "Sam P." }),
          responses: {
            200: jsonResponse("Contact updated.", {
              type: "object",
              required: ["updated", "contact"],
              description: "Updated contact response.",
              properties: {
                updated: { type: "boolean", description: "Always `true`." },
                contact: schemaRef("Contact"),
              },
            }),
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
        delete: {
          operationId: "deleteContact",
          tags: ["Drafts & Contacts"],
          summary: "Remove a contact from an identity's address book",
          description: "Deletes the specified contact (`mail:write`).",
          security: apiSecurity,
          parameters: [paramRef("AddressPath"), paramRef("RequiredIdentityQuery")],
          responses: {
            200: jsonResponse("Contact deleted.", {
              type: "object",
              required: ["deleted", "address", "identity"],
              description: "Deleted contact receipt.",
              properties: {
                deleted: { type: "boolean", description: "Always `true`." },
                address: schemaRef("EmailAddress"),
                identity: schemaRef("EmailAddress"),
              },
            }, { deleted: true, address: "sam@example.com", identity: "owner@example.com" }),
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
      },
      "/v1/external/status": {
        get: {
          operationId: "getExternalStatus",
          tags: ["Autopilot & External"],
          summary: "Inspect external IMAP/SMTP replication state",
          description: "Lists per-folder UID checkpoints and sync health for allowlisted external accounts (`mail:read`).",
          security: apiSecurity,
          responses: {
            200: jsonResponse("External account status list.", {
              type: "object",
              required: ["accounts"],
              description: "External status payload.",
              properties: { accounts: { type: "array", description: "Accessible external accounts.", items: { type: "object", description: "Account sync status." } } },
            }),
            ...errorResponses(401, 403, 429),
          },
        },
      },
      "/v1/external/sync": {
        post: {
          operationId: "syncExternalAccounts",
          tags: ["Autopilot & External"],
          summary: "Pull a batch of external IMAP messages",
          description: "Replicates up to `maxMessages` messages from configured IMAP accounts (`mail:write`).",
          security: apiSecurity,
          requestBody: jsonBody("Optional sync scope and batch size.", {
            type: "object",
            description: "External sync options.",
            properties: {
              identity: { oneOf: [schemaRef("EmailAddress"), { type: "null" }], description: "Optional single external identity to sync." },
              maxMessages: { type: "integer", minimum: 1, maximum: 200, default: 40, description: "Maximum messages to pull in this batch." },
            },
          }, { maxMessages: 40 }, false),
          responses: {
            200: jsonResponse("Sync batch report.", {
              type: "object",
              required: ["done", "syncedMessages", "skippedMessages", "accounts"],
              description: "External sync summary.",
              properties: {
                done: { type: "boolean", description: "True when all folders caught up." },
                syncedMessages: { type: "integer", minimum: 0, description: "New messages imported." },
                skippedMessages: { type: "integer", minimum: 0, description: "Messages skipped." },
                accounts: { type: "array", description: "Per-account sync details.", items: { type: "object", description: "Account sync result." } },
              },
            }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/autopilot": {
        get: {
          operationId: "getAutopilotStatus",
          tags: ["Autopilot & External"],
          summary: "Read autopilot settings, rules, spend today, and 24h activity",
          description: "Returns Clef triage settings, rules, today's USD spend, and action counts over the past 24 hours (`mail:read`).",
          security: apiSecurity,
          responses: {
            200: jsonResponse("Autopilot status.", {
              type: "object",
              required: ["settings", "spentTodayUsd", "rules", "last24h", "untriagedLast48h"],
              description: "Autopilot dashboard payload.",
              properties: {
                settings: schemaRef("AutopilotSettings"),
                spentTodayUsd: { type: "number", minimum: 0, description: "USD spent since 00:00 UTC across triage, drafts, and brief." },
                rules: { type: "array", description: "Configured autopilot rules.", items: schemaRef("AutopilotRule") },
                last24h: { type: "object", description: "Action counts in the last 24 hours keyed by action kind." },
                untriagedLast48h: { type: "integer", minimum: 0, description: "Ready inbound messages from the last 48h awaiting triage." },
              },
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(401, 403, 429),
          },
        },
        patch: {
          operationId: "updateAutopilotSettings",
          tags: ["Autopilot & External"],
          summary: "Update global autopilot switches or daily spend cap",
          description: "Owner-only mutation updating autopilot flags or `dailyCapUsd` (`mail:write` + owner access).",
          security: apiSecurity,
          requestBody: jsonBody("Autopilot settings patch.", {
            type: "object",
            additionalProperties: false,
            description: "Mutable autopilot settings.",
            properties: {
              enabled: { type: "boolean", description: "Enable or pause rules, drafts, and brief." },
              drafts: { type: "boolean", description: "Toggle automatic reply drafting." },
              brief: { type: "boolean", description: "Toggle 07:00 daily brief." },
              dailyCapUsd: { type: "number", minimum: 0, maximum: 20, description: "Daily Workers AI spend cap (`0..20` USD)." },
            },
          }, { enabled: true, dailyCapUsd: 0.5 }),
          responses: {
            200: jsonResponse("Updated settings.", {
              type: "object",
              required: ["settings"],
              description: "Settings wrapper.",
              properties: { settings: schemaRef("AutopilotSettings") },
            }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/autopilot/rules": {
        post: {
          operationId: "createAutopilotRule",
          tags: ["Autopilot & External"],
          summary: "Create an inbox autopilot rule",
          description: "Owner-only creation of a triage category rule (`mail:write` + owner access).",
          security: apiSecurity,
          requestBody: jsonBody("Autopilot rule definition.", {
            type: "object",
            required: ["category", "action"],
            additionalProperties: false,
            description: "New rule payload.",
            properties: {
              category: { type: "string", enum: ["personal", "school", "agent", "notification", "code", "receipt", "newsletter"], description: "Category to match." },
              action: { type: "string", enum: ["archive", "read", "star"], description: "Action to take." },
              identity: { oneOf: [schemaRef("EmailAddress"), { type: "null" }], description: "Optional mailbox filter." },
              senderMatch: { type: ["string", "null"], minLength: 3, maxLength: 254, description: "Optional exact email address or `@domain`." },
              maxUrgency: { type: "integer", minimum: 0, maximum: 3, description: "Maximum urgency (`0..3`, default `3`)." },
              minConfidence: { type: "number", minimum: 0.5, maximum: 1, description: "Minimum confidence (`0.5..1`, default `0.8`)." },
              enabled: { type: "boolean", description: "Initial enabled state (default `true`)." },
            },
          }, { category: "newsletter", action: "archive", minConfidence: 0.8 }),
          responses: {
            201: jsonResponse("Created rule.", {
              type: "object",
              required: ["created", "rule"],
              description: "Rule creation receipt.",
              properties: { created: { type: "boolean", description: "Always `true`." }, rule: schemaRef("AutopilotRule") },
            }),
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/autopilot/rules/{id}": {
        patch: {
          operationId: "updateAutopilotRule",
          tags: ["Autopilot & External"],
          summary: "Modify an autopilot rule",
          description: "Owner-only partial update of an autopilot rule (`mail:write` + owner access).",
          security: apiSecurity,
          parameters: [paramRef("RuleIdPath")],
          requestBody: jsonBody("Partial rule update.", {
            type: "object",
            minProperties: 1,
            additionalProperties: false,
            description: "Fields to modify.",
            properties: {
              category: { type: "string", enum: ["personal", "school", "agent", "notification", "code", "receipt", "newsletter"], description: "Category." },
              action: { type: "string", enum: ["archive", "read", "star"], description: "Action." },
              identity: { oneOf: [schemaRef("EmailAddress"), { type: "null" }], description: "Mailbox filter." },
              senderMatch: { type: ["string", "null"], minLength: 3, maxLength: 254, description: "Address or `@domain`." },
              maxUrgency: { type: "integer", minimum: 0, maximum: 3, description: "Max urgency." },
              minConfidence: { type: "number", minimum: 0.5, maximum: 1, description: "Min confidence." },
              enabled: { type: "boolean", description: "Enabled state." },
            },
          }, { enabled: false }),
          responses: {
            200: jsonResponse("Updated rule.", {
              type: "object",
              required: ["updated", "rule"],
              description: "Rule update receipt.",
              properties: { updated: { type: "boolean", description: "Always `true`." }, rule: schemaRef("AutopilotRule") },
            }),
            ...errorResponses(400, 401, 403, 404, 429),
          },
        },
        delete: {
          operationId: "deleteAutopilotRule",
          tags: ["Autopilot & External"],
          summary: "Delete an autopilot rule",
          description: "Owner-only removal of an autopilot rule (`mail:write` + owner access).",
          security: apiSecurity,
          parameters: [paramRef("RuleIdPath")],
          responses: {
            200: jsonResponse("Deleted rule.", {
              type: "object",
              required: ["deleted", "id"],
              description: "Rule deletion receipt.",
              properties: { deleted: { type: "boolean", description: "Always `true`." }, id: { type: "string", description: "Deleted rule ID." } },
            }, { deleted: true, id: "rule-12345678" }),
            ...errorResponses(401, 403, 404, 429),
          },
        },
      },
      "/v1/autopilot/actions": {
        get: {
          operationId: "listAutopilotActions",
          tags: ["Autopilot & External"],
          summary: "List logged autopilot actions",
          description: "Returns newest-first autopilot actions across allowlisted mailboxes (`mail:read`).",
          security: apiSecurity,
          parameters: [
            { name: "limit", in: "query", required: false, description: "Page size (`1..200`, default `50`).", schema: { type: "integer", minimum: 1, maximum: 200, default: 50, description: "Max actions." } },
            { name: "before", in: "query", required: false, description: "Pagination timestamp from `nextBefore`.", schema: { type: "string", description: "ISO/SQLite UTC timestamp." } },
            paramRef("IdentityQuery"),
          ],
          responses: {
            200: jsonResponse("Autopilot action log page.", {
              type: "object",
              required: ["actions", "nextBefore"],
              description: "Paginated actions.",
              properties: {
                actions: { type: "array", description: "Logged actions.", items: schemaRef("AutopilotAction") },
                nextBefore: { type: ["string", "null"], description: "Timestamp cursor for older actions." },
              },
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(400, 401, 403, 429),
          },
        },
      },
      "/v1/autopilot/actions/{id}/undo": {
        post: {
          operationId: "undoAutopilotAction",
          tags: ["Autopilot & External"],
          summary: "Undo a logged autopilot action",
          description: "Reverts an archive, read, star, spam, or draft action by full ID or unique 8+ char prefix inside allowlisted mailboxes (`mail:write`).",
          security: apiSecurity,
          parameters: [paramRef("ActionIdPath")],
          responses: {
            200: jsonResponse("Action undone.", {
              type: "object",
              required: ["undone", "id", "action", "messageId", "note"],
              description: "Undo outcome.",
              properties: {
                undone: { type: "boolean", description: "Always `true`." },
                id: { type: "string", description: "Full action UUID." },
                action: { type: "string", description: "Reverted action kind." },
                messageId: { type: "string", description: "Affected message ID." },
                note: { type: ["string", "null"], description: "Optional note if the owner had already changed the message." },
              },
            }),
            ...errorResponses(400, 401, 403, 404, 409, 429),
          },
        },
      },
      "/v1/autopilot/draft/{id}": {
        post: {
          operationId: "draftAutopilotReply",
          tags: ["Autopilot & External"],
          summary: "Draft a reply to one inbound message on demand",
          description: "Writes a style-matched reply draft using `DRAFT_MODEL` and saves it to `drafts` without sending (`mail:write`).",
          security: apiSecurity,
          parameters: [paramRef("MessageIdPath")],
          responses: {
            201: jsonResponse("Reply draft created.", {
              type: "object",
              required: ["drafted", "messageId", "draft"],
              description: "On-demand draft result.",
              properties: {
                drafted: { type: "boolean", description: "Always `true`." },
                messageId: { type: "string", description: "Source inbound message ID." },
                draft: { type: ["object", "null"], description: "Created draft summary (`id`, `subject`, `text`, `to`)." },
              },
            }),
            ...errorResponses(401, 403, 404, 409, 429),
          },
        },
      },
      "/v1/autopilot/brief": {
        post: {
          operationId: "writeAutopilotBrief",
          tags: ["Autopilot & External"],
          summary: "Deliver the daily brief into the owner's inbox now",
          description: "Owner-only trigger that tidies repeated alerts and writes a fresh brief message (`mail:write` + owner access).",
          security: apiSecurity,
          responses: {
            201: jsonResponse("Brief delivered.", {
              type: "object",
              required: ["written"],
              description: "Brief result.",
              properties: {
                written: { type: "boolean", description: "Always `true` on 201." },
                messageId: { type: "string", description: "Delivered brief message ID." },
              },
            }, { written: true, messageId: "brief_01" }),
            ...errorResponses(401, 403, 409, 429),
          },
        },
      },
      "/v1/autopilot/sweep": {
        post: {
          operationId: "runAutopilotSweep",
          tags: ["Autopilot & External"],
          summary: "Triage untriaged recent inbound mail and collapse repeated alerts",
          description: "Owner-only catch-up sweep across inbound messages from the past 48 hours (`mail:write` + owner access).",
          security: apiSecurity,
          responses: {
            200: jsonResponse("Sweep report.", {
              type: "object",
              required: ["triaged", "spam", "actions", "drafts", "stoppedEarly", "tidied"],
              description: "Autopilot sweep metrics.",
              properties: {
                triaged: { type: "integer", minimum: 0, description: "Messages newly classified." },
                spam: { type: "integer", minimum: 0, description: "Messages newly flagged as spam." },
                actions: { type: "integer", minimum: 0, description: "Rule and alert-collapse actions applied." },
                drafts: { type: "integer", minimum: 0, description: "Reply draft jobs enqueued." },
                stoppedEarly: { type: "boolean", description: "True if deadline, budget, or model outage stopped the sweep early." },
                tidied: { type: "integer", minimum: 0, description: "Repeated or resolved inbox alerts archived." },
              },
            }),
            ...errorResponses(401, 403, 429),
          },
        },
      },
      "/v1/addresses": {
        get: {
          operationId: "listAddresses",
          tags: ["Administration"],
          summary: "List enabled mailbox identities and managed domains",
          description: "Returns enabled mailbox identities visible to the calling credential (`addresses:read`).",
          security: apiSecurity,
          responses: {
            200: jsonResponse("Identities and managed domains.", {
              type: "object",
              required: ["addresses", "managedDomains"],
              description: "Addresses payload.",
              properties: {
                addresses: { type: "array", description: "Enabled mailbox identities.", items: schemaRef("Identity") },
                managedDomains: { type: "array", description: "Managed Cloudflare domains.", items: { type: "object", description: "Managed domain record." } },
              },
            }),
            304: { description: "Unchanged since client `If-None-Match` ETag." },
            ...errorResponses(401, 403, 429),
          },
        },
        post: {
          operationId: "createAddress",
          tags: ["Administration"],
          summary: "Create a routed mailbox identity and Cloudflare Email Routing rule",
          description: "Requires an unrestricted key with `addresses:write` and `X-Admin-Confirmation: user-approved`.",
          security: adminSecurity,
          requestBody: jsonBody("New routed identity payload.", {
            type: "object",
            required: ["address"],
            description: "Create address input.",
            properties: {
              address: schemaRef("EmailAddress"),
              displayName: { type: "string", minLength: 1, maxLength: 100, description: "Optional sender display name." },
              grantKeyIds: { type: "array", maxItems: 20, default: [], description: "Existing restricted key IDs to grant immediate access to.", items: { type: "string", minLength: 1, maxLength: 64, description: "API key ID." } },
            },
          }, { address: "hello@example.com", displayName: "Hello" }),
          responses: {
            201: jsonResponse("Identity and Email Routing rule created.", {
              type: "object",
              required: ["created", "address", "displayName", "zoneId", "routingRuleId", "domain", "grantedKeys", "skippedKeys"],
              description: "Created address receipt.",
              properties: {
                created: { type: "boolean", description: "Always `true`." },
                address: schemaRef("EmailAddress"),
                displayName: { type: "string", description: "Display name." },
                zoneId: { type: "string", description: "Cloudflare Zone ID." },
                routingRuleId: { type: "string", description: "Created Email Routing rule ID." },
                domain: { type: "object", description: "Domain onboarding summary." },
                grantedKeys: { type: "array", description: "Keys granted access.", items: { type: "object", description: "Granted key." } },
                skippedKeys: { type: "array", description: "Keys skipped.", items: { type: "object", description: "Skipped key." } },
              },
            }),
            ...errorResponses(400, 401, 403, 409, 428, 429),
          },
        },
      },
      "/v1/addresses/{address}": {
        patch: {
          operationId: "updateAddress",
          tags: ["Administration"],
          summary: "Update an identity's display name",
          description: "Requires an unrestricted key with `addresses:write` and `X-Admin-Confirmation: user-approved`.",
          security: adminSecurity,
          parameters: [paramRef("AddressPath")],
          requestBody: jsonBody("Updated display name.", {
            type: "object",
            required: ["displayName"],
            description: "Address display name update.",
            properties: { displayName: { type: "string", minLength: 1, maxLength: 100, description: "New sender display name." } },
          }, { displayName: "Support Team" }),
          responses: {
            200: jsonResponse("Display name updated.", {
              type: "object",
              required: ["updated", "address", "displayName"],
              description: "Address update receipt.",
              properties: {
                updated: { type: "boolean", description: "Always `true`." },
                address: schemaRef("EmailAddress"),
                displayName: { type: "string", description: "Updated display name." },
              },
            }),
            ...errorResponses(400, 401, 403, 404, 428, 429),
          },
        },
        delete: {
          operationId: "deleteAddress",
          tags: ["Administration"],
          summary: "Delete a non-owner mailbox identity and its Email Routing rule",
          description: "Requires an unrestricted key with `addresses:write` and `X-Admin-Confirmation: user-approved`. Refuses to delete `OWNER_EMAIL` (`409`).",
          security: adminSecurity,
          parameters: [paramRef("AddressPath")],
          responses: {
            200: jsonResponse("Identity deleted.", {
              type: "object",
              required: ["deleted", "address"],
              description: "Address deletion receipt.",
              properties: { deleted: { type: "boolean", description: "Always `true`." }, address: schemaRef("EmailAddress") },
            }, { deleted: true, address: "hello@example.com" }),
            ...errorResponses(400, 401, 403, 404, 409, 428, 429),
          },
        },
      },
      "/v1/keys": {
        get: {
          operationId: "listApiKeys",
          tags: ["Administration"],
          summary: "List API key metadata",
          description: "Lists stored API keys without secrets or hashes (`keys:read`, audited).",
          security: apiSecurity,
          responses: {
            200: jsonResponse("API keys list.", {
              type: "object",
              required: ["keys"],
              description: "Key list wrapper.",
              properties: { keys: { type: "array", description: "API keys.", items: schemaRef("ApiKeyMetadata") } },
            }),
            ...errorResponses(401, 403, 429),
          },
        },
        post: {
          operationId: "createApiKey",
          tags: ["Administration"],
          summary: "Issue a scoped `lm_live_` API key",
          description: "Mints a least-privilege API key bounded by the caller's own scopes and mailbox allowlist (`keys:write` + `X-Admin-Confirmation: user-approved`).",
          security: adminSecurity,
          requestBody: jsonBody("API key specification.", {
            type: "object",
            required: ["name", "scopes"],
            description: "New API key input.",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100, description: "Human-readable key name." },
              scopes: {
                type: "array",
                minItems: 1,
                maxItems: 9,
                description: "Requested scopes (`account:read`, `mail:read`, `mail:write`, `mail:send`, `addresses:read`, `addresses:write`, `keys:read`, `keys:write`, `audit:read`).",
                items: { type: "string", description: "Scope identifier." },
              },
              identities: {
                type: ["array", "null"],
                maxItems: 100,
                default: null,
                description: "Explicit mailbox allowlist (required when any `mail:*` scope is requested), or `null` for non-mail admin keys.",
                items: schemaRef("EmailAddress"),
              },
              expiresAt: { type: ["string", "null"], format: "date-time", default: null, description: "Optional future ISO 8601 expiry." },
            },
          }, { name: "ci-reader", scopes: ["mail:read"], identities: ["owner@example.com"], expiresAt: null }),
          responses: {
            201: jsonResponse("Issued API key (plaintext `token` shown once).", {
              type: "object",
              required: ["id", "token", "name", "scopes", "identities", "expiresAt", "warning"],
              description: "Issued key payload.",
              properties: {
                id: { type: "string", description: "16-character key ID." },
                token: { type: "string", description: "One-time `lm_live_<id>_<secret>` bearer token." },
                name: { type: "string", description: "Key label." },
                scopes: { type: "array", description: "Granted scopes.", items: { type: "string", description: "Scope." } },
                identities: { type: ["array", "null"], description: "Granted mailbox allowlist.", items: schemaRef("EmailAddress") },
                expiresAt: { type: ["string", "null"], description: "Expiry timestamp or `null`." },
                warning: { type: "string", description: "Keychain storage reminder." },
              },
            }),
            ...errorResponses(400, 401, 403, 428, 429),
          },
        },
      },
      "/v1/keys/device": {
        post: {
          operationId: "createDeviceApiKey",
          tags: ["Administration"],
          summary: "Issue a one-year single-identity `lm_device_` key",
          description: "Issues a legacy one-year device credential restricted to one enabled mailbox (`keys:write` + `X-Admin-Confirmation: user-approved`).",
          security: adminSecurity,
          requestBody: jsonBody("Device key request.", {
            type: "object",
            required: ["identity"],
            description: "Device key input.",
            properties: {
              name: { type: "string", minLength: 1, maxLength: 100, default: "ios-lmail", description: "Device label." },
              identity: schemaRef("EmailAddress"),
            },
          }, { name: "iphone", identity: "owner@example.com" }),
          responses: {
            201: jsonResponse("Issued device key (`token` shown once).", {
              type: "object",
              required: ["id", "token", "name", "scopes", "identities", "expiresAt", "warning"],
              description: "Issued device key payload.",
              properties: {
                id: { type: "string", description: "16-character key ID." },
                token: { type: "string", description: "One-time `lm_device_<id>_<secret>` token." },
                name: { type: "string", description: "Device label." },
                scopes: { type: "array", description: "Device mail scopes.", items: { type: "string", description: "Scope." } },
                identities: { type: "array", description: "Single bound identity.", items: schemaRef("EmailAddress") },
                expiresAt: { type: "string", format: "date-time", description: "One-year expiry timestamp." },
                warning: { type: "string", description: "Keychain storage reminder." },
              },
            }),
            ...errorResponses(400, 401, 403, 428, 429),
          },
        },
      },
      "/v1/keys/{id}": {
        delete: {
          operationId: "revokeApiKey",
          tags: ["Administration"],
          summary: "Revoke an active API key",
          description: "Immediately revokes another key whose mailbox access does not exceed the caller's (`keys:write` + `X-Admin-Confirmation: user-approved`).",
          security: adminSecurity,
          parameters: [paramRef("KeyIdPath")],
          responses: {
            200: jsonResponse("Key revoked.", {
              type: "object",
              required: ["revoked", "id"],
              description: "Revocation receipt.",
              properties: { revoked: { type: "boolean", description: "Always `true`." }, id: { type: "string", description: "Revoked key ID." } },
            }, { revoked: true, id: "k9f2m4x8p1q7z3w5" }),
            ...errorResponses(401, 403, 404, 409, 428, 429),
          },
        },
      },
    },
  };
}

// Add SendOutcome schema cleanly so $ref resolves.
const spec = buildOpenApiSpec();
spec.components.schemas.SendOutcome = {
  type: "object",
  required: ["sent", "status", "id", "messageId", "recipients"],
  description: "Durable outbound send outcome.",
  properties: {
    sent: { type: "boolean", description: "True when every recipient reached `sent`." },
    status: { type: "string", enum: ["complete", "partial", "failed", "unknown"], description: "Final send state." },
    error: { type: "string", description: "Present when delivery was not complete." },
    id: { type: "string", description: "Stored outbound message row ID." },
    messageId: { type: "string", description: "Generated RFC 5322 `Message-ID`." },
    recipients: {
      type: "array",
      description: "Per-recipient provider delivery statuses.",
      items: {
        type: "object",
        required: ["address", "kind", "status", "providerMessageId"],
        description: "Single recipient delivery result.",
        properties: {
          address: schemaRef("EmailAddress"),
          kind: { type: "string", enum: ["to", "cc", "bcc"], description: "Header field." },
          status: { type: "string", enum: ["pending", "sending", "sent", "failed", "unknown"], description: "Delivery status." },
          providerMessageId: { type: ["string", "null"], description: "Upstream provider message ID." },
        },
      },
    },
  },
};

export const serializedOpenApiSpec = `${JSON.stringify(spec, null, 2)}\n`;

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, serializedOpenApiSpec, "utf8");
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${Object.keys(spec.paths).length} paths)`);
}
