import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { runMailAgent } from "./agent";
import { listChats, markChatDraftSent, publicChatDraft, readChat, runChatTurn, updateChatDraft, type ChatDraftRow } from "./agent-chat";
import { auditRequest, hasScope, issueApiKey, issueDeviceApiKey, requireApiKey, requireScope, securityHeaders, type ApiVariables } from "./auth";
import { authenticationResultsFromRawHeaders, senderLogo, senderLogoCacheSeconds, senderPassedDmarc } from "./bimi";
import { avatarColor } from "./avatar";
import { RULE_ACTIONS, RULE_CATEGORIES, listRules, readAutopilotSettings, runAutopilotSweep, tidyInbox, undoAction, writeAutopilotSettings,
  type ActionRow, type RuleRow } from "./autopilot";
import { writeDailyBrief } from "./brief";
import { draftReply, latestDraft } from "./reply-drafts";
import { sha256 } from "./crypto";
import { appName, ROUTING_HOSTS, workerName } from "./config";
import { ensureManagedDomain, listManagedDomains } from "./domains";
import { buildDeliverabilityReport } from "./deliverability";
import { externalStatus, runExternalSync } from "./external";
import { kgStatus, runKnowledgeGraphSync } from "./kg";
import { performSend } from "./send";
import { autopilotSpendToday } from "./usage";
import type { ApiKeyRow, AttachmentRow, ContactRow, Env, IdentityRow, MessageRow, SendRecipientRow, SendRequestRow } from "./types";

export const api = new Hono<{ Bindings: Env; Variables: ApiVariables }>();

const KNOWN_SCOPES = ["account:read", "mail:read", "mail:write", "mail:send", "addresses:read", "addresses:write", "keys:read", "keys:write", "audit:read"];
const MAIL_SCOPES = new Set(["mail:read", "mail:write", "mail:send"]);
const DEVICE_MAIL_SCOPES = ["account:read", "mail:read", "mail:write", "mail:send", "addresses:read"];
const ROUTING_HOST_SET = new Set<string>(ROUTING_HOSTS);
const MAX_API_BODY_BYTES = 7 * 1024 * 1024;
const MAX_THREAD_MESSAGES = 100;
// 'spam' is a virtual folder: the rows keep their real folder and are selected
// by the spam flag instead. Every other folder excludes them.
const MAILBOX_FOLDERS = new Set(["inbox", "sent", "archive", "trash", "starred", "all", "spam"]);
const SNAPSHOT_FOLDERS = new Set([...MAILBOX_FOLDERS, "drafts"]);
const MESSAGE_LIST_COLUMNS = `id, thread_id, direction, folder, subject, sender_name, sender_address,
  recipients_json, preview, received_at, unread, starred, has_attachments, attachment_count,
  stored_attachment_count, size, spam, triage_category, triage_confidence, triage_needs_reply, triage_urgency`;
type LogoMessage = Pick<MessageRow, "id" | "direction" | "sender_address" | "recipients_json" | "raw_key" | "sender_authenticated">;
type MailSummaryRow = { unread: number; inbox: number; sent: number; starred: number; archive: number; trash: number; drafts: number; spam: number };
type DraftRow = { id: string; identity_address: string; reply_to_message_id: string | null; recipients_json: string;
  cc_json: string; bcc_json: string; subject: string; text_body: string; updated_at: string };
type SnapshotDatabaseRow = MessageRow | DraftRow | IdentityRow | MailSummaryRow | { revision: number };
type MailboxChangeRow = { revision: number; entity_kind: "message" | "draft"; entity_id: string;
  operation: "upsert" | "delete"; thread_id: string | null; previous_folder: string | null; payload_json: string | null };
const requireAdminConfirmation: MiddlewareHandler<{ Bindings: Env; Variables: ApiVariables }> = async (c, next) => {
  if (c.req.header("X-Admin-Confirmation") !== "user-approved") {
    return c.json({ error: "Explicit user confirmation is required for this administrative mutation", requestId: c.get("requestId") }, 428);
  }
  await next();
};
const emailAddress = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const identityDisplayName = z.string().trim().min(1).max(100)
  .refine((value) => !/[\r\n\0]/.test(value), "Display name contains forbidden control characters");
const contactDisplayName = z.string().trim().max(100)
  .refine((value) => !/[\r\n\0]/.test(value), "Contact name contains forbidden control characters");
const base64Data = z.string().min(1).max(6_000_000).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const sendSchema = z.object({
  idempotencyKey: z.string().uuid(),
  from: emailAddress,
  to: z.array(emailAddress).min(1).max(20),
  cc: z.array(emailAddress).max(20).default([]),
  bcc: z.array(emailAddress).max(20).default([]),
  subject: z.string().max(998).default(""),
  text: z.string().max(2_500_000),
  html: z.string().max(2_500_000).nullish().transform((value) => value ?? undefined),
  replyToMessageId: z.string().max(64).nullish().transform((value) => value ?? undefined),
  attachments: z.array(z.object({ filename: z.string().min(1).max(255), contentType: z.string().min(1).max(127), data: base64Data })).max(10).default([]),
}).refine((data) => new Set([...data.to, ...data.cc, ...data.bcc]).size <= 20, { message: "At most 20 unique recipients are allowed" });
const draftSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/).nullish().transform((value) => value ?? undefined), from: emailAddress,
  replyToMessageId: z.string().max(64).nullish().transform((value) => value ?? undefined),
  to: z.array(emailAddress).max(50).default([]), cc: z.array(emailAddress).max(50).default([]),
  bcc: z.array(emailAddress).max(50).default([]), subject: z.string().max(998).default(""), text: z.string().max(2_500_000).default(""),
});
const pushDeviceSchema = z.object({
  deviceToken: z.string().regex(/^[a-f0-9]{64,400}$/),
  environment: z.enum(["development", "production"]),
  identities: z.array(emailAddress).min(1).max(100),
});
const agentSchema = z.object({
  prompt: z.string().min(1).max(8_000),
  identity: emailAddress.nullish().transform((value) => value ?? undefined),
  maxSteps: z.number().int().min(1).max(16).default(8),
  stream: z.boolean().default(false),
  // Continue a saved chat (streaming only).
  chatId: z.string().max(64).nullish().transform((value) => value ?? undefined),
});
const chatTurnSchema = z.object({
  chatId: z.string().max(64).nullish().transform((value) => value ?? undefined),
  text: z.string().trim().min(1).max(8_000),
  identity: emailAddress.nullish().transform((value) => value ?? undefined),
  maxSteps: z.number().int().min(1).max(16).default(10),
});
const chatDraftSchema = z.object({
  from: emailAddress.optional(), to: z.array(emailAddress).max(20).optional(), cc: z.array(emailAddress).max(20).optional(),
  subject: z.string().max(998).optional(), body: z.string().max(100_000).optional(),
}).strict();
const externalSyncSchema = z.object({
  identity: emailAddress.nullish().transform((value) => value ?? undefined),
  maxMessages: z.number().int().min(1).max(200).default(40),
});

api.use("*", securityHeaders);
api.use("*", requireApiKey);
api.use("*", auditRequest);
api.use("*", bodyLimit({ maxSize: MAX_API_BODY_BYTES,
  onError: (c) => c.json({ error: "Request body exceeds 7 MiB", requestId: c.get("requestId") }, 413) }));

api.get("/whoami", requireScope("account:read"), (c) => c.json({ principal: c.get("principal"), owner: c.env.OWNER_EMAIL }));

api.get("/deliverability", requireScope("account:read"), requireScope("addresses:read"), async (c) => {
  const parsed = z.coerce.number().int().min(1).max(168).safeParse(c.req.query("hours") ?? "24");
  if (!parsed.success) return apiError(c, 400, "hours must be an integer between 1 and 168");
  return c.json(await buildDeliverabilityReport(c.env, parsed.data));
});

api.get("/doctor", requireScope("account:read"), requireScope("addresses:read"), async (c) => {
  const startedAt = Date.now();
  const access = identityAccess(c, "address");
  const identitiesResult = await c.env.DB.prepare(`SELECT * FROM identities WHERE enabled = 1 AND kind = 'routed' AND ${access.sql} ORDER BY address`)
    .bind(...access.bindings).all<IdentityRow>();
  const identities = identitiesResult.results;
  const zoneIds = [...new Set(identities.map((identity) => identity.zone_id))];
  const senderDomains = [...new Set(identities.map((identity) => identity.address.split("@")[1]))].sort();
  const [objectList, zones, dnsDomains] = await Promise.all([
    c.env.MAIL.list({ limit: 1 }),
    Promise.all(zoneIds.map(async (zoneId) => {
      const rules = await cloudflareRequest<CloudflareRoutingRule[]>(c.env, zoneId, "/email/routing/rules?per_page=100", "GET");
      return { zoneId, rules };
    })),
    Promise.all(senderDomains.map(async (domain) => {
      const [mx, txt, dkim, dmarc] = await Promise.all([
        resolveDns(domain, "MX"), resolveDns(domain, "TXT"),
        resolveDns(`cf-bounce._domainkey.${domain}`, "TXT"), resolveDns(`_dmarc.${domain}`, "TXT"),
      ]);
      return { domain, mx, txt, dkim, dmarc };
    })),
  ]);
  const messageAccess = identityAccess(c, "identity_address");
  const outboundAccess = identityAccess(c, "m.identity_address");
  const [messageStates, outboundStates, queueMetrics] = await Promise.all([
    c.env.DB.prepare(`SELECT
    COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
    COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
    COALESCE(SUM(CASE WHEN status = 'failed' AND updated_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END), 0) AS failed_7d
    FROM messages WHERE ${messageAccess.sql}`).bind(...messageAccess.bindings).first<{ pending: number; failed: number; failed_7d: number }>(),
    c.env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN sr.status IN ('processing', 'reserved', 'sending', 'partial', 'unknown') THEN 1 ELSE 0 END), 0) AS unresolved,
      COALESCE(SUM(CASE WHEN sr.status = 'failed' AND sr.created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END), 0) AS failed_24h
      FROM send_requests sr LEFT JOIN messages m ON m.id = sr.message_row_id
      WHERE ${outboundAccess.sql}`).bind(...outboundAccess.bindings).first<{ unresolved: number; failed_24h: number }>(),
    c.env.MAIL_QUEUE.metrics().catch(() => null),
  ]);
  // A domain only needs the Email Sending DKIM key when mail actually goes out from it;
  // receive-only domains (routing only) sign nothing and must not turn the report red.
  const sendingRows = await c.env.DB.prepare(`SELECT DISTINCT lower(substr(identity_address, instr(identity_address, '@') + 1)) AS domain
    FROM messages WHERE direction = 'outbound' AND created_at >= datetime('now', '-90 days') AND ${messageAccess.sql}`)
    .bind(...messageAccess.bindings).all<{ domain: string }>();
  const sendingDomains = new Set(sendingRows.results.map((row) => row.domain));
  const zoneMap = new Map(zones.map((zone) => [zone.zoneId, zone]));
  const routing = identities.map((identity) => {
    const rule = zoneMap.get(identity.zone_id)?.rules.find((candidate) => candidate.id === identity.routing_rule_id);
    const matcherOk = rule?.matchers.some((matcher) => matcher.type === "literal" && matcher.value.toLowerCase() === identity.address) ?? false;
    const actionOk = rule?.actions.some((action) => action.type === "worker" && action.value.includes(workerName(c.env))) ?? false;
    return { address: identity.address, ok: Boolean(rule?.enabled && matcherOk && actionOk), enabled: rule?.enabled ?? false,
      matcherOk, actionOk, routingRuleId: identity.routing_rule_id };
  });
  const dnsMap = new Map(dnsDomains.map((entry) => [entry.domain, entry]));
  const domains = senderDomains.map((domain) => {
    const dns = dnsMap.get(domain);
    const mxHosts = new Set((dns?.mx ?? []).map((answer) => answer.data.split(/\s+/).at(-1)?.replace(/\.$/, "")));
    const mxOk = ROUTING_HOST_SET.size === mxHosts.size && [...ROUTING_HOST_SET].every((host) => mxHosts.has(host));
    const spfOk = dns?.txt.some((answer) => answer.data.includes("v=spf1") && answer.data.includes("include:_spf.mx.cloudflare.net")) ?? false;
    const dkimOk = dns?.dkim.some((answer) => answer.data.includes("v=DKIM1")) ?? false;
    const dmarcPolicy = dns?.dmarc.map((answer) => answer.data.match(/(?:^|;)\s*p=(none|quarantine|reject)(?:;|\s|$)/i)?.[1]?.toLowerCase())
      .find((policy) => policy !== undefined) ?? null;
    const dmarcOk = dmarcPolicy === "quarantine" || dmarcPolicy === "reject";
    const sending = sendingDomains.has(domain);
    return { domain, sending, ok: mxOk && spfOk && (dkimOk || !sending) && dmarcOk,
      providerReady: { ok: mxOk && spfOk && dkimOk, verifiedBy: "public-dns" },
      dns: { ok: mxOk && spfOk && dkimOk && dmarcOk, mx: mxOk, spf: spfOk, dkim: dkimOk,
        dmarc: dmarcOk, dmarcPolicy } };
  });
  // Old failures stay visible as failedMessages but only the last 7 days decide health:
  // an inbound mail whose raw object is gone can never be processed again.
  const database = { ok: (messageStates?.pending ?? 0) === 0 && (messageStates?.failed_7d ?? 0) === 0
      && (outboundStates?.unresolved ?? 0) === 0 && (outboundStates?.failed_24h ?? 0) === 0,
    identities: identities.length, pendingMessages: messageStates?.pending ?? 0, failedMessages: messageStates?.failed ?? 0,
    failedMessages7d: messageStates?.failed_7d ?? 0,
    unresolvedSends: outboundStates?.unresolved ?? 0, failedSends24h: outboundStates?.failed_24h ?? 0 };
  const objectStorage = { ok: Boolean(objectList), sampledObjects: objectList.objects.length };
  const queueAgeMs = queueMetrics?.oldestMessageTimestamp ? Date.now() - queueMetrics.oldestMessageTimestamp.getTime() : null;
  const queue = queueMetrics ? { ok: queueAgeMs === null || queueAgeMs < 15 * 60_000, backlog: queueMetrics.backlogCount,
    backlogBytes: queueMetrics.backlogBytes, oldestMessageTimestamp: queueMetrics.oldestMessageTimestamp?.toISOString() ?? null,
    oldestMessageAgeSeconds: queueAgeMs === null ? null : Math.max(0, Math.round(queueAgeMs / 1_000)) }
    : { ok: false, error: "Queue metrics unavailable" };
  const externalAccounts = (await externalStatus(c.env)).filter((account) => canAccessIdentity(c, account.identity));
  const external = externalAccounts.map((account) => ({
    identity: account.identity,
    ok: !account.enabled || account.folders.every((folder) => folder.lastError === null),
    enabled: account.enabled,
    imapHost: account.imapHost,
    smtpHost: account.smtpHost,
    folders: account.folders,
  }));
  const checks = { database, objectStorage, queue, routing, domains, external };
  const healthy = database.ok && objectStorage.ok && queue.ok && routing.every((item) => item.ok)
    && domains.every((item) => item.ok) && external.every((item) => item.ok);
  return c.json({ healthy, owner: c.env.OWNER_EMAIL, checkedAt: new Date().toISOString(), durationMs: Date.now() - startedAt, checks });
});

api.get("/summary", requireScope("mail:read"), async (c) => {
  const access = requestedIdentityAccess(c, "identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");
  const row = await mailboxSummaryStatement(c.env, access).first<MailSummaryRow>();
  return privateJson(c, normalizedSummary(row));
});

api.put("/push-devices", requireScope("mail:read"), async (c) => {
  const input = pushDeviceSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid push device registration", input.error.flatten());
  const identities = [...new Set(input.data.identities)];
  if (identities.some((identity) => !canAccessIdentity(c, identity))) {
    return apiError(c, 403, "Push registration includes an inaccessible identity");
  }
  const enabled = await c.env.DB.prepare(`SELECT address FROM identities WHERE enabled = 1
    AND address IN (${identities.map(() => "?").join(",")}) ORDER BY address`).bind(...identities).all<{ address: string }>();
  if (enabled.results.length !== identities.length) return apiError(c, 400, "Every push identity must be enabled");
  const id = await sha256(`${input.data.environment}:${input.data.deviceToken}`);
  await c.env.DB.prepare(`INSERT INTO push_devices
    (id, key_id, device_token, environment, identities_json)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET key_id = excluded.key_id, identities_json = excluded.identities_json,
      disabled_at = NULL, failure_count = 0, updated_at = CURRENT_TIMESTAMP`)
    .bind(id, c.get("principal").keyId, input.data.deviceToken, input.data.environment,
      JSON.stringify(enabled.results.map((row) => row.address))).run();
  return c.json({ registered: true, identities: enabled.results.map((row) => row.address) });
});

api.delete("/push-devices", requireScope("mail:read"), async (c) => {
  const input = z.object({ deviceToken: z.string().regex(/^[a-f0-9]{64,400}$/),
    environment: z.enum(["development", "production"]) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid push device removal", input.error.flatten());
  await c.env.DB.prepare(`DELETE FROM push_devices WHERE key_id = ? AND device_token = ? AND environment = ?`)
    .bind(c.get("principal").keyId, input.data.deviceToken, input.data.environment).run();
  return c.json({ removed: true });
});

api.get("/mailbox-state", requireScope("mail:read"), async (c) => {
  const access = requestedIdentityAccess(c, "identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");
  const after = z.string().regex(/^\d+$/).max(20).safeParse(c.req.query("after") ?? "");
  if (c.req.query("after") !== undefined && !after.success) return apiError(c, 400, "Invalid mailbox revision");
  const wait = z.coerce.number().int().min(0).max(25).safeParse(c.req.query("wait") ?? "0");
  if (!wait.success) return apiError(c, 400, "wait must be an integer between 0 and 25 seconds");

  let revision = await mailboxRevision(c.env, access);
  const requestedRevision = after.success ? after.data : null;
  const deadline = Date.now() + wait.data * 1_000;
  let pollDelayMs = 1_000;
  while (requestedRevision === revision && Date.now() < deadline) {
    try {
      await scheduler.wait(Math.min(pollDelayMs, deadline - Date.now()), { signal: c.req.raw.signal });
    } catch (error) {
      if (c.req.raw.signal.aborted || error instanceof DOMException && error.name === "AbortError") {
        return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
      }
      throw error;
    }
    if (c.req.raw.signal.aborted) return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
    revision = await mailboxRevision(c.env, access);
    pollDelayMs = Math.min(pollDelayMs * 2, 5_000);
  }
  return c.json({ revision, changed: requestedRevision !== null && requestedRevision !== revision }, 200, {
    "Cache-Control": "private, no-store",
  });
});

api.get("/mailbox-delta", requireScope("mail:read"), async (c) => {
  const exact = requestedExactIdentityAccess(c, "identity_address");
  if (!exact) return apiError(c, 400, "mailbox-delta requires one valid identity");
  const sinceResult = z.string().regex(/^\d+$/).max(20).safeParse(c.req.query("since") ?? "");
  if (!sinceResult.success) return apiError(c, 400, "since must be a mailbox revision");
  const limit = boundedLimit(c.req.query("limit"), 100, 250);
  const cursor = decodeDeltaCursor(c.req.query("cursor"));
  if (c.req.query("cursor") !== undefined && !cursor) return apiError(c, 400, "Invalid mailbox delta cursor");
  const since = BigInt(sinceResult.data);
  if (cursor && cursor.since !== sinceResult.data) return apiError(c, 400, "Delta cursor does not match since revision");

  const current = await mailboxRevision(c.env, exact.access);
  const through = cursor?.through ?? current;
  const after = cursor?.after ?? sinceResult.data;
  if (BigInt(through) > BigInt(current) || BigInt(after) < since || BigInt(after) > BigInt(through)) {
    return apiError(c, 400, "Invalid mailbox delta cursor range");
  }
  if (since > BigInt(current)) {
    return privateJson(c, deltaResetPayload(sinceResult.data, current, "revision_ahead"));
  }

  const [oldestResult, changesResult, summaryResult] = await c.env.DB.batch<MailboxChangeRow | MailSummaryRow | { revision: number }>([
    c.env.DB.prepare("SELECT MIN(revision) AS revision FROM mailbox_changes WHERE identity_address = ?")
      .bind(exact.identity),
    c.env.DB.prepare(`SELECT revision, entity_kind, entity_id, operation, thread_id, previous_folder, payload_json
      FROM mailbox_changes WHERE identity_address = ? AND revision > ? AND revision <= ?
      ORDER BY revision ASC LIMIT ?`).bind(exact.identity, after, through, limit + 1),
    mailboxSummaryStatement(c.env, exact.access),
  ]);
  const oldestValue = oldestResult.results[0];
  const oldest = oldestValue && "revision" in oldestValue && oldestValue.revision !== null
    ? BigInt(oldestValue.revision) : null;
  if (since < BigInt(through) && (oldest === null || since + 1n < oldest)) {
    return privateJson(c, deltaResetPayload(sinceResult.data, current, "history_expired"));
  }

  const rows = changesResult.results.filter(isMailboxChangeRow);
  const page = rows.slice(0, limit);
  let expected = BigInt(after) + 1n;
  for (const change of page) {
    if (BigInt(change.revision) !== expected) {
      return privateJson(c, deltaResetPayload(sinceResult.data, current, "non_contiguous"));
    }
    expected += 1n;
  }
  if (page.length === 0 && BigInt(after) < BigInt(through)) {
    return privateJson(c, deltaResetPayload(sinceResult.data, current, "non_contiguous"));
  }
  const hasMore = rows.length > limit;
  const lastRevision = String(page.at(-1)?.revision ?? after);
  const summaryRow = summaryResult.results[0];
  return privateJson(c, {
    identity: exact.identity,
    fromRevision: sinceResult.data,
    revision: through,
    changes: page.map(publicMailboxChange),
    summary: normalizedSummary(summaryRow && "inbox" in summaryRow ? summaryRow : undefined),
    hasMore,
    nextCursor: hasMore ? encodeDeltaCursor({ since: sinceResult.data, after: lastRevision, through }) : null,
    resetRequired: false,
  });
});

api.get("/mailbox-snapshot", requireScope("mail:read"), async (c) => {
  const folder = c.req.query("folder") ?? "inbox";
  const query = (c.req.query("query") ?? "").trim();
  if (!SNAPSHOT_FOLDERS.has(folder)) return apiError(c, 400, "Invalid folder");
  if (new TextEncoder().encode(query).byteLength > 50) return apiError(c, 400, "Query exceeds 50 bytes");
  const includeAddresses = booleanQuery(c.req.query("includeAddresses"));
  if (includeAddresses === null) return apiError(c, 400, "includeAddresses must be 0 or 1");
  if (includeAddresses && !hasScope(c.get("principal").scopes, "addresses:read")) {
    return apiError(c, 403, "Including addresses requires the addresses:read scope");
  }
  const limit = boundedLimit(c.req.query("limit"), 50, 100);
  const access = requestedIdentityAccess(c, "identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");

  const statements: D1PreparedStatement[] = [
    mailboxRevisionStatement(c.env, access),
    mailboxSummaryStatement(c.env, access),
    folder === "drafts"
      ? c.env.DB.prepare(`SELECT id, identity_address, reply_to_message_id, recipients_json, cc_json, bcc_json,
          subject, text_body, updated_at FROM drafts WHERE ${access.sql} ORDER BY updated_at DESC LIMIT 100`)
        .bind(...access.bindings)
      : messageListStatement(c.env, access, { folder, query, limit, cursor: decodeCursor(undefined) }),
  ];
  if (includeAddresses) {
    const addressAccess = identityAccess(c, "address");
    statements.push(c.env.DB.prepare(`SELECT address, display_name, zone_id, routing_rule_id, enabled, created_at, updated_at
      FROM identities WHERE enabled = 1 AND ${addressAccess.sql} ORDER BY address`).bind(...addressAccess.bindings));
  }
  const results = await c.env.DB.batch<SnapshotDatabaseRow>(statements);
  const revisionRow = results[0]?.results[0];
  const summaryRow = results[1]?.results[0];
  const revision = String(revisionRow && "revision" in revisionRow ? revisionRow.revision : 0);
  const summary = normalizedSummary(summaryRow && "inbox" in summaryRow ? summaryRow : undefined);
  const data = results[2]?.results ?? [];
  const messageRows = folder === "drafts" ? [] : data.filter(isMessageRow);
  const draftRows = folder === "drafts" ? data.filter(isDraftRow) : [];
  const hasMore = messageRows.length > limit;
  const selected = messageRows.slice(0, limit);
  const last = selected.at(-1);
  const addresses = includeAddresses ? (results[3]?.results ?? []).filter(isIdentityRow) : undefined;
  return privateJson(c, {
    revision,
    summary,
    messages: selected.map(publicMessage),
    nextCursor: hasMore && last ? encodeCursor(last.received_at, last.id) : null,
    drafts: draftRows.map(publicDraft),
    ...(addresses ? { addresses: addresses.map(publicIdentity) } : {}),
  });
});

api.get("/messages", requireScope("mail:read"), async (c) => {
  const folder = c.req.query("folder") ?? "inbox";
  const query = (c.req.query("query") ?? "").trim();
  if (new TextEncoder().encode(query).byteLength > 50) return apiError(c, 400, "Query exceeds 50 bytes");
  const limit = boundedLimit(c.req.query("limit"), 50, 100);
  const cursor = decodeCursor(c.req.query("cursor"));
  const access = requestedIdentityAccess(c, "identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");
  if (!MAILBOX_FOLDERS.has(folder)) return apiError(c, 400, "Invalid folder");
  const result = await messageListStatement(c.env, access, { folder, query, limit, cursor }).all<MessageRow>();
  const hasMore = result.results.length > limit;
  const rows = result.results.slice(0, limit);
  const last = rows.at(-1);
  return privateJson(c, { messages: rows.map(publicMessage), nextCursor: hasMore && last ? encodeCursor(last.received_at, last.id) : null });
});

api.get("/messages/:id/sender-logo", requireScope("mail:read"), async (c) => {
  const access = identityAccess(c, "identity_address");
  const message = await c.env.DB.prepare(`SELECT id, direction, sender_address, recipients_json, raw_key, sender_authenticated
    FROM messages WHERE id = ? AND status = 'ready' AND ${access.sql}`)
    .bind(c.req.param("id"), ...access.bindings).first<LogoMessage>();
  if (!message) return apiError(c, 404, "Sender logo not available");
  const address = logoAddress(message);
  const domain = logoDomain(message);
  if (!address || !domain) return apiError(c, 404, "Sender logo not available");

  if (message.direction === "inbound" && !await authenticateLogoMessage(c.env, message, domain)) {
    return apiError(c, 404, "Sender logo not available");
  }

  const asset = await senderLogo(c.env, domain, address);
  if (!asset) return apiError(c, 404, "Sender logo not available");
  const body = new ArrayBuffer(asset.data.byteLength);
  new Uint8Array(body).set(asset.data);
  const etag = normalizedEtag(asset.etag ?? await sha256(body));
  const logoHeaders = {
    "Content-Type": asset.contentType,
    "Cache-Control": `private, max-age=${senderLogoCacheSeconds}, immutable`,
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "X-Content-Type-Options": "nosniff",
    ETag: etag,
  };
  if (requestMatchesEtag(c.req.header("If-None-Match"), etag)) return new Response(null, { status: 304, headers: logoHeaders });
  return new Response(body, { headers: { ...logoHeaders, "Content-Length": String(asset.data.byteLength) } });
});

api.post("/logo-backfill", requireScope("mail:read"), async (c) => {
  const parsedCursor = z.string().max(128).safeParse(c.req.query("cursor") ?? "");
  if (!parsedCursor.success) return apiError(c, 400, "Invalid logo backfill cursor");
  const access = identityAccess(c, "identity_address");
  const result = await c.env.DB.prepare(`SELECT id, direction, sender_address, recipients_json, raw_key, sender_authenticated
    FROM messages WHERE status = 'ready' AND id > ? AND ${access.sql} ORDER BY id LIMIT 11`)
    .bind(parsedCursor.data, ...access.bindings).all<LogoMessage>();
  const batch = result.results.slice(0, 10);
  const eligible = await Promise.all(batch.map(async (message) => {
    const address = logoAddress(message);
    const domain = logoDomain(message);
    if (!address || !domain) return null;
    if (message.direction === "inbound" && !await authenticateLogoMessage(c.env, message, domain)) return null;
    return { address, domain };
  }));
  const correspondents = [...new Map(eligible.filter((item): item is { address: string; domain: string } => item !== null)
    .map((item) => [item.address, item])).values()];
  const byDomain = new Map<string, Array<{ address: string; domain: string }>>();
  for (const item of correspondents) byDomain.set(item.domain, [...(byDomain.get(item.domain) ?? []), item]);
  await Promise.all([...byDomain.values()].map(async (items) => {
    for (const item of items) await senderLogo(c.env, item.domain, item.address).catch(() => null);
  }));
  return c.json({ processed: batch.length, nextCursor: result.results.length > 10 ? batch.at(-1)?.id ?? null : null });
});

api.get("/messages/:id", requireScope("mail:read"), async (c) => {
  const access = requestedIdentityAccess(c, "identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");
  const message = await c.env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND status = 'ready' AND ${access.sql}`)
    .bind(c.req.param("id"), ...access.bindings).first<MessageRow>();
  if (!message) return apiError(c, 404, "Message not found");
  const [text, html, related] = await Promise.all([
    readObject(c.env.MAIL, message.text_key), readObject(c.env.MAIL, message.html_key),
    c.env.DB.batch<AttachmentRow | MessageRow>([
      c.env.DB.prepare("SELECT id, filename, content_type, content_id, size, disposition FROM attachments WHERE message_id = ? ORDER BY rowid").bind(message.id),
      c.env.DB.prepare(`SELECT ${MESSAGE_LIST_COLUMNS} FROM messages WHERE thread_id = ? AND status = 'ready'
        AND ${access.sql} ORDER BY received_at DESC, id DESC LIMIT ?`).bind(message.thread_id, ...access.bindings, MAX_THREAD_MESSAGES + 1),
    ]),
  ]);
  const attachments = (related[0]?.results ?? []).filter(isAttachmentRow);
  const thread = (related[1]?.results ?? []).filter(isMessageRow);
  const threadTruncated = thread.length > MAX_THREAD_MESSAGES;
  const threadMessages = thread.slice(0, MAX_THREAD_MESSAGES).reverse();
  return privateJson(c, { ...publicMessage(message), messageId: message.message_id, inReplyTo: message.in_reply_to,
    cc: publicAddressList(message.cc_json), text, html,
    attachments: attachments.map((item) => ({ id: item.id, filename: item.filename, contentType: item.content_type,
      contentId: item.content_id, size: item.size, disposition: item.disposition })),
    thread: threadMessages.map(publicMessage), threadTruncated });
});

api.get("/messages/:id/raw", requireScope("mail:read"), async (c) => {
  const access = identityAccess(c, "identity_address");
  const row = await c.env.DB.prepare(`SELECT raw_key FROM messages WHERE id = ? AND status = 'ready' AND ${access.sql}`)
    .bind(c.req.param("id"), ...access.bindings).first<{ raw_key: string }>();
  if (!row) return apiError(c, 404, "Message not found");
  const object = await c.env.MAIL.get(row.raw_key);
  if (!object) return apiError(c, 404, "Raw message not found");
  return new Response(object.body, { headers: { "Content-Type": "message/rfc822",
    "Content-Disposition": `attachment; filename="${c.req.param("id")}.eml"`,
    "Cache-Control": "private, max-age=2592000, immutable", ETag: object.httpEtag } });
});

api.patch("/messages/:id", requireScope("mail:write"), async (c) => {
  const input = z.object({ unread: z.boolean().optional(), starred: z.boolean().optional(),
    folder: z.enum(["inbox", "sent", "archive", "trash"]).optional(), spam: z.boolean().optional() })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success || Object.keys(input.data).length === 0) return apiError(c, 400, "No valid update supplied", input.success ? undefined : input.error.flatten());
  const assignments: string[] = [];
  const bindings: unknown[] = [];
  for (const [key, value] of Object.entries(input.data)) { assignments.push(`${key} = ?`); bindings.push(typeof value === "boolean" ? Number(value) : value); }
  const access = identityAccess(c, "identity_address");
  const result = await c.env.DB.prepare(`UPDATE messages SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'ready' AND ${access.sql}`).bind(...bindings, c.req.param("id"), ...access.bindings).run();
  if (!result.meta.changes) return apiError(c, 404, "Message not found");
  return c.json({ updated: true });
});

api.get("/attachments/:id", requireScope("mail:read"), async (c) => {
  const access = identityAccess(c, "m.identity_address");
  const attachment = await c.env.DB.prepare(`SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
    WHERE a.id = ? AND m.status = 'ready' AND ${access.sql}`).bind(c.req.param("id"), ...access.bindings).first<AttachmentRow>();
  if (!attachment) return apiError(c, 404, "Attachment not found");
  const object = await c.env.MAIL.get(attachment.object_key);
  if (!object) return apiError(c, 404, "Attachment object not found");
  const safeName = attachment.filename.replaceAll(/[\r\n"\\/]/g, "_");
  return new Response(object.body, { headers: { "Content-Type": attachment.content_type, "Content-Length": String(attachment.size),
    "Content-Disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    "Cache-Control": "private, max-age=2592000, immutable", ETag: object.httpEtag, "X-Content-Type-Options": "nosniff" } });
});

api.post("/messages/send", requireScope("mail:send"), async (c) => {
  const input = sendSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid message", input.error.flatten());
  if (!canAccessIdentity(c, input.data.from)) return apiError(c, 403, "Sender identity is outside this key's access policy");
  const sendLimit = await c.env.SEND_RATE_LIMITER.limit({ key: c.get("principal").keyId });
  if (!sendLimit.success) return apiError(c, 429, "Send rate limit exceeded");
  const outcome = await performSend(c.env, {
    keyId: c.get("principal").keyId,
    allowedIdentities: c.get("principal").allowedIdentities,
    ...input.data,
  });
  if (outcome.kind === "error") return apiError(c, outcome.status, outcome.message);
  return c.json(outcome.result.response, outcome.result.statusCode);
});

api.post("/agent", requireScope("mail:read"), async (c) => {
  const input = agentSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid agent request", input.error.flatten());
  if (input.data.identity && !canAccessIdentity(c, input.data.identity)) {
    return apiError(c, 403, "Agent identity is outside this key's access policy");
  }
  try {
    if (input.data.stream) {
      // A streamed run is a chat turn, so it shows up in the app's chat history.
      if (input.data.chatId && requireOwner(c)) return apiError(c, 403, "Saved chats need a key with access to the owner's mailbox");
      const response = await runChatTurn(c.env, c.get("principal"), { chatId: input.data.chatId, text: input.data.prompt,
        identity: input.data.identity, maxSteps: input.data.maxSteps, fullAccess: requireOwner(c) === null },
      (promise) => c.executionCtx.waitUntil(promise));
      return response ?? apiError(c, 404, "Chat not found");
    }
    // The owner's agent sees every mailbox, as in his chats.
    const principal = requireOwner(c) === null ? { ...c.get("principal"), allowedIdentities: null } : c.get("principal");
    return c.json(await runMailAgent(c.env, principal, input.data));
  } catch (error) {
    console.error("Agent run failed", { requestId: c.get("requestId"), error: String(error).slice(0, 500) });
    return apiError(c, 500, `Agent run failed: ${String(error).slice(0, 300)}`);
  }
});

// Agent chats hold what the agent read in every mailbox: they are the owner's.
api.get("/agent/chats", requireScope("mail:read"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  return privateJson(c, { chats: await listChats(c.env, boundedLimit(c.req.query("limit"), 50, 200)) });
});

api.post("/agent/chats", requireScope("mail:read"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const input = chatTurnSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid chat message", input.error.flatten());
  if (input.data.identity && !canAccessIdentity(c, input.data.identity)) return apiError(c, 403, "Identity is outside this key's access policy");
  try {
    const response = await runChatTurn(c.env, c.get("principal"), { ...input.data, fullAccess: true },
      (promise) => c.executionCtx.waitUntil(promise));
    return response ?? apiError(c, 404, "Chat not found");
  } catch (error) {
    console.error("Agent chat turn failed", { requestId: c.get("requestId"), error: String(error).slice(0, 500) });
    return apiError(c, 500, `Agent run failed: ${String(error).slice(0, 300)}`);
  }
});

api.get("/agent/chats/:id", requireScope("mail:read"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const chat = await readChat(c.env, c.req.param("id"));
  return chat ? privateJson(c, chat) : apiError(c, 404, "Chat not found");
});

api.patch("/agent/chats/:id", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const input = z.object({ title: z.string().trim().min(1).max(120) }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid chat", input.error.flatten());
  const result = await c.env.DB.prepare("UPDATE agent_chats SET title = ? WHERE id = ?").bind(input.data.title, c.req.param("id")).run();
  return result.meta.changes ? c.json({ updated: true }) : apiError(c, 404, "Chat not found");
});

api.delete("/agent/chats/:id", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const result = await c.env.DB.prepare("DELETE FROM agent_chats WHERE id = ?").bind(c.req.param("id")).run();
  return result.meta.changes ? c.json({ deleted: true, id: c.req.param("id") }) : apiError(c, 404, "Chat not found");
});

api.patch("/agent/chats/:id/drafts/:draftId", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const input = chatDraftSchema.extend({ status: z.enum(["draft", "discarded"]).optional() }).strict()
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid draft", input.error.flatten());
  if (input.data.from && !canAccessIdentity(c, input.data.from)) return apiError(c, 403, "Sender identity is outside this key's access policy");
  const row = await updateChatDraft(c.env, c.req.param("id"), c.req.param("draftId"), input.data);
  return row ? c.json({ draft: publicChatDraft(row) }) : apiError(c, 404, "Draft not found");
});

// The only way an email the agent wrote leaves the mailbox: the owner's client
// sends it, with his final edits, after he confirmed it. The agent has no tool for this.
api.post("/agent/chats/:id/drafts/:draftId/send", requireScope("mail:send"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const input = chatDraftSchema.extend({ idempotencyKey: z.string().uuid() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid send request", input.error.flatten());
  const { idempotencyKey, ...edits } = input.data;
  const current = await c.env.DB.prepare("SELECT * FROM agent_chat_drafts WHERE id = ? AND chat_id = ?")
    .bind(c.req.param("draftId"), c.req.param("id")).first<ChatDraftRow>();
  if (!current) return apiError(c, 404, "Draft not found");
  if (current.status === "sent") return c.json({ sent: true, alreadySent: true, draft: publicChatDraft(current) });
  const draft = Object.keys(edits).length ? await updateChatDraft(c.env, current.chat_id, current.id, edits) : current;
  if (!draft) return apiError(c, 404, "Draft not found");
  const to = JSON.parse(draft.to_json) as string[];
  if (!to.length) return apiError(c, 400, "The email has no recipient");
  if (!canAccessIdentity(c, draft.identity_address)) return apiError(c, 403, "Sender identity is outside this key's access policy");
  const sendLimit = await c.env.SEND_RATE_LIMITER.limit({ key: c.get("principal").keyId });
  if (!sendLimit.success) return apiError(c, 429, "Send rate limit exceeded");
  const outcome = await performSend(c.env, {
    keyId: c.get("principal").keyId, allowedIdentities: c.get("principal").allowedIdentities, idempotencyKey,
    from: draft.identity_address, to, cc: JSON.parse(draft.cc_json) as string[], bcc: [], subject: draft.subject, text: draft.body,
    replyToMessageId: draft.reply_to_message_id ?? undefined, attachments: [],
  });
  if (outcome.kind === "error") return apiError(c, outcome.status, outcome.message);
  const response = outcome.result.response as { sent?: boolean; id?: string };
  if (response.sent) await markChatDraftSent(c.env, draft.id, response.id ?? null);
  const updated = await c.env.DB.prepare("SELECT * FROM agent_chat_drafts WHERE id = ?").bind(draft.id).first<ChatDraftRow>();
  return c.json({ ...outcome.result.response, draft: updated ? publicChatDraft(updated) : null }, outcome.result.statusCode);
});

api.get("/external/status", requireScope("mail:read"), async (c) => {
  return c.json({ accounts: (await externalStatus(c.env)).filter((account) => canAccessIdentity(c, account.identity)) });
});

api.get("/kg/status", requireScope("mail:read"), async (c) => c.json(await kgStatus(c.env)));

api.post("/kg/sync", requireScope("mail:write"), async (c) => {
  const input = z.object({ maxMessages: z.number().int().min(1).max(100).default(25) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!input.success) return apiError(c, 400, "Invalid knowledge-graph sync request", input.error.flatten());
  return c.json(await runKnowledgeGraphSync(c.env, { maxMessages: input.data.maxMessages, deadlineMs: 50_000 }));
});

// Autopilot: settings, rules and the action log. The autopilot is the owner's:
// changing it needs a key with access to his own mailbox, so a key limited to
// some other address (an agent's, a device's) cannot.
function requireOwner(c: Context<{ Bindings: Env; Variables: ApiVariables }>): Response | null {
  return canAccessIdentity(c, c.env.OWNER_EMAIL) ? null
    : apiError(c, 403, "Autopilot settings and rules need a key with access to the owner's mailbox");
}

api.get("/autopilot", requireScope("mail:read"), async (c) => {
  const [settings, spentTodayUsd, rules, recent, untriaged] = await Promise.all([
    readAutopilotSettings(c.env), autopilotSpendToday(c.env), listRules(c.env),
    c.env.DB.prepare(`SELECT action, COUNT(*) AS count FROM autopilot_actions
      WHERE created_at >= datetime('now', '-1 day') AND undone_at IS NULL GROUP BY action`).all<{ action: string; count: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM messages WHERE triaged_at IS NULL AND direction = 'inbound' AND status = 'ready'
      AND received_at >= ?`).bind(new Date(Date.now() - 48 * 3_600_000).toISOString()).first<{ count: number }>(),
  ]);
  return privateJson(c, { settings, spentTodayUsd: Math.round(spentTodayUsd * 1e6) / 1e6, rules: rules.map(publicRule),
    last24h: Object.fromEntries(recent.results.map((row) => [row.action, row.count])), untriagedLast48h: untriaged?.count ?? 0 });
});

api.patch("/autopilot", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const input = z.object({ enabled: z.boolean().optional(), drafts: z.boolean().optional(), brief: z.boolean().optional(),
    dailyCapUsd: z.number().min(0).max(20).optional() }).strict().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid autopilot settings", input.error.flatten());
  return c.json({ settings: await writeAutopilotSettings(c.env, input.data) });
});

const ruleInput = z.object({
  category: z.enum(RULE_CATEGORIES), action: z.enum(RULE_ACTIONS),
  identity: emailAddress.nullable().optional(), senderMatch: z.string().trim().toLowerCase().min(3).max(254)
    .regex(/^(@[a-z0-9.-]+\.[a-z]{2,}|[^@\s]+@[a-z0-9.-]+\.[a-z]{2,})$/, "An address or @domain").nullable().optional(),
  maxUrgency: z.number().int().min(0).max(3).optional(), minConfidence: z.number().min(0.5).max(1).optional(),
  enabled: z.boolean().optional(),
}).strict();

api.post("/autopilot/rules", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const input = ruleInput.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid rule", input.error.flatten());
  const id = `rule-${crypto.randomUUID().slice(0, 8)}`;
  await c.env.DB.prepare(`INSERT INTO autopilot_rules (id, category, action, identity_address, sender_match, max_urgency, min_confidence, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, input.data.category, input.data.action, input.data.identity ?? null,
    input.data.senderMatch ?? null, input.data.maxUrgency ?? 3, input.data.minConfidence ?? 0.8, input.data.enabled === false ? 0 : 1).run();
  const row = await c.env.DB.prepare("SELECT * FROM autopilot_rules WHERE id = ?").bind(id).first<RuleRow>();
  return c.json({ created: true, rule: publicRule(row!) }, 201);
});

api.patch("/autopilot/rules/:id", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const input = ruleInput.partial().safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid rule", input.error.flatten());
  const columns: Array<[string, string | number | null]> = [];
  if (input.data.category !== undefined) columns.push(["category", input.data.category]);
  if (input.data.action !== undefined) columns.push(["action", input.data.action]);
  if (input.data.identity !== undefined) columns.push(["identity_address", input.data.identity]);
  if (input.data.senderMatch !== undefined) columns.push(["sender_match", input.data.senderMatch]);
  if (input.data.maxUrgency !== undefined) columns.push(["max_urgency", input.data.maxUrgency]);
  if (input.data.minConfidence !== undefined) columns.push(["min_confidence", input.data.minConfidence]);
  if (input.data.enabled !== undefined) columns.push(["enabled", input.data.enabled ? 1 : 0]);
  if (!columns.length) return apiError(c, 400, "Nothing to change");
  const result = await c.env.DB.prepare(`UPDATE autopilot_rules SET ${columns.map(([column]) => `${column} = ?`).join(", ")},
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(...columns.map(([, value]) => value), c.req.param("id")).run();
  if (!result.meta.changes) return apiError(c, 404, "Rule not found");
  const row = await c.env.DB.prepare("SELECT * FROM autopilot_rules WHERE id = ?").bind(c.req.param("id")).first<RuleRow>();
  return c.json({ updated: true, rule: publicRule(row!) });
});

api.delete("/autopilot/rules/:id", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const result = await c.env.DB.prepare("DELETE FROM autopilot_rules WHERE id = ?").bind(c.req.param("id")).run();
  if (!result.meta.changes) return apiError(c, 404, "Rule not found");
  return c.json({ deleted: true, id: c.req.param("id") });
});

api.get("/autopilot/actions", requireScope("mail:read"), async (c) => {
  const access = requestedIdentityAccess(c, "m.identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");
  const limit = boundedLimit(c.req.query("limit"), 50, 200);
  const before = c.req.query("before") ?? "9999-12-31 23:59:59";
  if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z?$/.test(before)) return apiError(c, 400, "before must be a timestamp from nextBefore");
  const rows = await c.env.DB.prepare(`SELECT a.*, m.subject, m.sender_address, m.sender_name, m.identity_address
    FROM autopilot_actions a JOIN messages m ON m.id = a.message_id
    WHERE a.created_at < ? AND ${access.sql} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
    .bind(before, ...access.bindings, limit + 1).all<ActionRow & { sender_name: string }>();
  const page = rows.results.slice(0, limit);
  return privateJson(c, { actions: page.map(publicAction), nextBefore: rows.results.length > limit ? page.at(-1)?.created_at ?? null : null });
});

api.post("/autopilot/actions/:id/undo", requireScope("mail:write"), async (c) => {
  const access = identityAccess(c, "m.identity_address");
  const id = c.req.param("id");
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return apiError(c, 400, "Invalid action id");
  // The brief shows the first eight characters; they are enough when unique.
  const rows = await c.env.DB.prepare(`SELECT a.*, m.subject, m.sender_address, m.identity_address
    FROM autopilot_actions a JOIN messages m ON m.id = a.message_id
    WHERE (a.id = ? OR (length(?) >= 8 AND a.id LIKE ? || '%')) AND ${access.sql} LIMIT 2`)
    .bind(id, id, id.replace(/[%_]/g, ""), ...access.bindings).all<ActionRow>();
  if (rows.results.length === 0) return apiError(c, 404, "Action not found");
  if (rows.results.length > 1) return apiError(c, 409, "That id prefix matches more than one action");
  const action = rows.results[0]!;
  const result = await undoAction(c.env, action);
  if (!result.undone) return apiError(c, 409, result.reason ?? "Cannot undo");
  return c.json({ undone: true, id: action.id, action: action.action, messageId: action.message_id, note: result.reason ?? null });
});

api.post("/autopilot/draft/:id", requireScope("mail:write"), async (c) => {
  const access = identityAccess(c, "identity_address");
  const message = await c.env.DB.prepare(`SELECT id FROM messages WHERE id = ? AND direction = 'inbound' AND status = 'ready' AND ${access.sql}`)
    .bind(c.req.param("id"), ...access.bindings).first<{ id: string }>();
  if (!message) return apiError(c, 404, "Message not found");
  const outcome = await draftReply(c.env, message.id, { onDemand: true });
  if (outcome !== "drafted") return apiError(c, 409, outcome === "skipped" ? "Over today's autopilot budget" : "No draft written");
  return c.json({ drafted: true, messageId: message.id, draft: await latestDraft(c.env, message.id) }, 201);
});

api.post("/autopilot/brief", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const result = await writeDailyBrief(c.env);
  return result.written ? c.json(result, 201) : apiError(c, 409, result.reason ?? "No brief written");
});

api.post("/autopilot/sweep", requireScope("mail:write"), async (c) => {
  const denied = requireOwner(c);
  if (denied) return denied;
  const report = await runAutopilotSweep(c.env, { maxMessages: 25, deadlineMs: 25_000 });
  return c.json({ ...report, tidied: await tidyInbox(c.env) });
});

api.post("/external/sync", requireScope("mail:write"), async (c) => {
  const input = externalSyncSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!input.success) return apiError(c, 400, "Invalid sync request", input.error.flatten());
  if (input.data.identity && !canAccessIdentity(c, input.data.identity)) {
    return apiError(c, 403, "Sync identity is outside this key's access policy");
  }
  return c.json(await runExternalSync(c.env, {
    identity: input.data.identity,
    maxMessages: input.data.maxMessages,
    deadlineMs: 50_000,
  }));
});

api.get("/send-requests/:idempotencyKey", requireScope("mail:send"), async (c) => {
  const parsed = z.string().uuid().safeParse(c.req.param("idempotencyKey"));
  if (!parsed.success) return apiError(c, 400, "Invalid idempotency key");
  const keyId = c.get("principal").keyId;
  const request = await c.env.DB.prepare(`SELECT key_id, idempotency_key, request_hash, message_id, message_row_id,
    status, response_json, error_message, created_at, updated_at FROM send_requests WHERE key_id = ? AND idempotency_key = ?`)
    .bind(keyId, parsed.data).first<SendRequestRow>();
  if (!request) return apiError(c, 404, "Send request not found");
  const recipients = await c.env.DB.prepare(`SELECT recipient, kind, status, attempts, provider_message_id, error_message
    FROM send_recipients WHERE key_id = ? AND idempotency_key = ? ORDER BY kind, recipient`)
    .bind(keyId, parsed.data).all<SendRecipientRow>();
  return c.json({ idempotencyKey: request.idempotency_key, status: request.status, messageId: request.message_id,
    messageRowId: request.message_row_id, error: request.error_message, createdAt: request.created_at, updatedAt: request.updated_at,
    recipients: recipients.results.map((item) => ({ address: item.recipient, kind: item.kind, status: item.status,
      attempts: item.attempts, providerMessageId: item.provider_message_id, error: item.error_message })) });
});

api.get("/drafts", requireScope("mail:read"), async (c) => {
  const access = requestedIdentityAccess(c, "identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");
  const rows = await c.env.DB.prepare(`SELECT * FROM drafts WHERE ${access.sql} ORDER BY updated_at DESC LIMIT 100`)
    .bind(...access.bindings).all<DraftRow>();
  return privateJson(c, { drafts: rows.results.map(publicDraft) });
});

api.put("/drafts", requireScope("mail:write"), async (c) => {
  const input = draftSchema.safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid draft", input.error.flatten());
  if (!canAccessIdentity(c, input.data.from)) return apiError(c, 403, "Draft identity is outside this key's access policy");
  const identity = await c.env.DB.prepare("SELECT address FROM identities WHERE address = ? AND enabled = 1").bind(input.data.from).first();
  if (!identity) return apiError(c, 403, "Draft identity is not enabled");
  if (input.data.replyToMessageId) {
    const access = identityAccess(c, "identity_address");
    const reply = await c.env.DB.prepare(`SELECT id FROM messages WHERE id = ? AND ${access.sql}`)
      .bind(input.data.replyToMessageId, ...access.bindings).first();
    if (!reply) return apiError(c, 404, "Reply target not found");
  }
  const id = input.data.id ?? crypto.randomUUID();
  if (input.data.id) {
    // Saving under an existing id overwrites that draft: only inside the key's own mailboxes.
    const existing = await c.env.DB.prepare("SELECT identity_address FROM drafts WHERE id = ?").bind(id).first<{ identity_address: string }>();
    if (existing && !canAccessIdentity(c, existing.identity_address)) return apiError(c, 404, "Draft not found");
  }
  await c.env.DB.prepare(`INSERT INTO drafts (id, identity_address, reply_to_message_id, recipients_json, cc_json, bcc_json, subject, text_body)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET identity_address = excluded.identity_address,
    reply_to_message_id = excluded.reply_to_message_id,
    recipients_json = excluded.recipients_json, cc_json = excluded.cc_json, bcc_json = excluded.bcc_json,
    subject = excluded.subject, text_body = excluded.text_body, updated_at = CURRENT_TIMESTAMP`)
    .bind(id, input.data.from, input.data.replyToMessageId ?? null, JSON.stringify(input.data.to), JSON.stringify(input.data.cc),
      JSON.stringify(input.data.bcc), input.data.subject, input.data.text).run();
  return c.json({ saved: true, id });
});

api.delete("/drafts/:id", requireScope("mail:write"), async (c) => {
  const access = identityAccess(c, "identity_address");
  const result = await c.env.DB.prepare(`DELETE FROM drafts WHERE id = ? AND ${access.sql}`)
    .bind(c.req.param("id"), ...access.bindings).run();
  if (!result.meta.changes) return apiError(c, 404, "Draft not found");
  return c.json({ deleted: true });
});

api.get("/contacts", requireScope("mail:read"), async (c) => {
  const access = requestedIdentityAccess(c, "identity_address");
  if (!access) return apiError(c, 400, "Invalid identity filter");
  const query = (c.req.query("query") ?? "").trim().toLowerCase();
  if (new TextEncoder().encode(query).byteLength > 100) return apiError(c, 400, "Contact query exceeds 100 bytes");
  const limit = boundedLimit(c.req.query("limit"), 50, 200);
  const conditions = [access.sql];
  const bindings: unknown[] = [...access.bindings];
  let ranking = "send_count DESC, COALESCE(last_sent_at, updated_at) DESC, address ASC";
  if (query) {
    const escaped = query.replaceAll(/[\\%_]/g, "\\$&");
    const contains = `%${escaped}%`;
    const prefix = `${escaped}%`;
    conditions.push("(lower(address) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')");
    bindings.push(contains, contains);
    ranking = `CASE
      WHEN lower(address) = ? THEN 0
      WHEN lower(address) LIKE ? ESCAPE '\\' THEN 1
      WHEN lower(display_name) LIKE ? ESCAPE '\\' THEN 2
      ELSE 3 END,
      send_count DESC, COALESCE(last_sent_at, updated_at) DESC, address ASC`;
    bindings.push(query, prefix, prefix);
  }
  const rows = await c.env.DB.prepare(`SELECT identity_address, address, display_name, source, send_count,
    first_sent_at, last_sent_at, created_at, updated_at
    FROM contacts WHERE ${conditions.join(" AND ")} ORDER BY ${ranking} LIMIT ?`)
    .bind(...bindings, limit).all<ContactRow>();
  return c.json({ contacts: rows.results.map(publicContact) });
});

api.post("/contacts", requireScope("mail:write"), async (c) => {
  const input = z.object({ identity: emailAddress, address: emailAddress, displayName: contactDisplayName.optional().default("") })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid contact", input.error.flatten());
  if (!canAccessIdentity(c, input.data.identity)) return apiError(c, 403, "Contact identity is outside this key's access policy");
  const identity = await c.env.DB.prepare("SELECT address FROM identities WHERE address = ? AND enabled = 1")
    .bind(input.data.identity).first<{ address: string }>();
  if (!identity) return apiError(c, 404, "Contact identity is not enabled");
  await c.env.DB.prepare(`INSERT INTO contacts (identity_address, address, display_name, source)
    VALUES (?, ?, ?, 'manual')
    ON CONFLICT(identity_address, address) DO UPDATE SET
      display_name = excluded.display_name, source = 'manual', updated_at = CURRENT_TIMESTAMP`)
    .bind(input.data.identity, input.data.address, input.data.displayName).run();
  const row = await c.env.DB.prepare("SELECT * FROM contacts WHERE identity_address = ? AND address = ?")
    .bind(input.data.identity, input.data.address).first<ContactRow>();
  return c.json({ created: true, contact: publicContact(row!) }, 201);
});

api.patch("/contacts/:address", requireScope("mail:write"), async (c) => {
  let decoded: string;
  try { decoded = decodeURIComponent(c.req.param("address")); } catch { return apiError(c, 400, "Invalid contact address encoding"); }
  const address = emailAddress.safeParse(decoded);
  const input = z.object({ identity: emailAddress, displayName: contactDisplayName })
    .safeParse(await c.req.json().catch(() => null));
  if (!address.success || !input.success) return apiError(c, 400, "Invalid contact", input.success ? undefined : input.error.flatten());
  if (!canAccessIdentity(c, input.data.identity)) return apiError(c, 403, "Contact identity is outside this key's access policy");
  const result = await c.env.DB.prepare(`UPDATE contacts SET display_name = ?, source = 'manual', updated_at = CURRENT_TIMESTAMP
    WHERE identity_address = ? AND address = ?`)
    .bind(input.data.displayName, input.data.identity, address.data).run();
  if (!result.meta.changes) return apiError(c, 404, "Contact not found");
  const row = await c.env.DB.prepare("SELECT * FROM contacts WHERE identity_address = ? AND address = ?")
    .bind(input.data.identity, address.data).first<ContactRow>();
  return c.json({ updated: true, contact: publicContact(row!) });
});

api.delete("/contacts/:address", requireScope("mail:write"), async (c) => {
  let decoded: string;
  try { decoded = decodeURIComponent(c.req.param("address")); } catch { return apiError(c, 400, "Invalid contact address encoding"); }
  const address = emailAddress.safeParse(decoded);
  const identity = emailAddress.safeParse(c.req.query("identity"));
  if (!address.success || !identity.success) return apiError(c, 400, "A valid contact address and identity are required");
  if (!canAccessIdentity(c, identity.data)) return apiError(c, 403, "Contact identity is outside this key's access policy");
  const result = await c.env.DB.prepare("DELETE FROM contacts WHERE identity_address = ? AND address = ?")
    .bind(identity.data, address.data).run();
  if (!result.meta.changes) return apiError(c, 404, "Contact not found");
  return c.json({ deleted: true, address: address.data, identity: identity.data });
});

api.get("/addresses", requireScope("addresses:read"), async (c) => {
  const access = identityAccess(c, "address");
  const rows = await c.env.DB.prepare(`SELECT address, display_name, zone_id, routing_rule_id, enabled, created_at, updated_at
    FROM identities WHERE enabled = 1 AND ${access.sql} ORDER BY address`)
    .bind(...access.bindings).all<IdentityRow>();
  return privateJson(c, { addresses: rows.results.map(publicIdentity), managedDomains: await listManagedDomains(c.env) });
});

api.post("/addresses", requireScope("addresses:write"), requireAdminConfirmation, async (c) => {
  if (c.get("principal").allowedIdentities !== null) return apiError(c, 403, "Address administration requires an unrestricted administrator key");
  if (!await consumeAdminLimit(c)) return apiError(c, 429, "Administrative rate limit exceeded");
  const input = z.object({ address: emailAddress, displayName: identityDisplayName.optional(),
    grantKeyIds: z.array(z.string().trim().min(1).max(64)).max(20).default([]) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid address", input.error.flatten());
  const address = input.data.address; const domain = address.split("@")[1];
  const existing = await c.env.DB.prepare("SELECT address FROM identities WHERE address = ?").bind(address).first();
  if (existing) return apiError(c, 409, "Address already exists");
  // Any domain or subdomain of a zone in the account works: an unknown one
  // is taken under management here (zone lookup, Email Routing DNS).
  let managed;
  try { managed = await ensureManagedDomain(c.env, domain); }
  catch (error) {
    return apiError(c, 400, "Domain cannot be managed", { domain, reason: error instanceof Error ? error.message : String(error),
      managedDomains: await listManagedDomains(c.env) });
  }
  const zoneId = managed.zoneId;
  const rule = await cloudflareRequest<{ id: string }>(c.env, zoneId, "/email/routing/rules", "POST", {
    name: `${appName(c.env)}: ${address}`, enabled: true, matchers: [{ type: "literal", field: "to", value: address }], actions: [{ type: "worker", value: [workerName(c.env)] }],
  });
  try {
    await c.env.DB.prepare("INSERT INTO identities (address, display_name, zone_id, routing_rule_id) VALUES (?, ?, ?, ?)")
      .bind(address, input.data.displayName ?? defaultDisplayName(address), zoneId, rule.id).run();
  } catch (error) {
    await cloudflareRequest(c.env, zoneId, `/email/routing/rules/${rule.id}`, "DELETE").catch(() => undefined);
    throw error;
  }
  // The creator may hand the new, still empty mailbox to existing restricted
  // keys (the CLI passes its everyday key), so the address is usable at once.
  const grantedKeys: Array<{ id: string; name: string; access: "granted" | "unrestricted" }> = [];
  const skippedKeys: Array<{ id: string; reason: string }> = [];
  for (const keyId of new Set(input.data.grantKeyIds)) {
    const key = await c.env.DB.prepare("SELECT id, name, allowed_identities_json, revoked_at FROM api_keys WHERE id = ?")
      .bind(keyId).first<{ id: string; name: string; allowed_identities_json: string | null; revoked_at: string | null }>();
    if (!key || key.revoked_at) { skippedKeys.push({ id: keyId, reason: "unknown or revoked key" }); continue; }
    if (key.allowed_identities_json === null) { grantedKeys.push({ id: key.id, name: key.name, access: "unrestricted" }); continue; }
    const identities = new Set(storedStringArray(key.allowed_identities_json)); identities.add(address);
    await c.env.DB.prepare("UPDATE api_keys SET allowed_identities_json = ? WHERE id = ?").bind(JSON.stringify([...identities]), key.id).run();
    grantedKeys.push({ id: key.id, name: key.name, access: "granted" });
  }
  return c.json({ created: true, address, displayName: input.data.displayName ?? defaultDisplayName(address), zoneId, routingRuleId: rule.id,
    domain: { name: domain, newlyManaged: managed.newlyManaged, steps: managed.steps }, grantedKeys, skippedKeys }, 201);
});

api.patch("/addresses/:address", requireScope("addresses:write"), requireAdminConfirmation, async (c) => {
  if (c.get("principal").allowedIdentities !== null) return apiError(c, 403, "Address administration requires an unrestricted administrator key");
  let decoded: string;
  try { decoded = decodeURIComponent(c.req.param("address")); } catch { return apiError(c, 400, "Invalid address encoding"); }
  const address = emailAddress.safeParse(decoded);
  const body = z.object({ displayName: identityDisplayName }).safeParse(await c.req.json().catch(() => null));
  if (!address.success || !body.success) return apiError(c, 400, "Invalid address display name", body.success ? undefined : body.error.flatten());
  const result = await c.env.DB.prepare("UPDATE identities SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE address = ? AND enabled = 1")
    .bind(body.data.displayName, address.data).run();
  if (!result.meta.changes) return apiError(c, 404, "Address not found");
  return c.json({ updated: true, address: address.data, displayName: body.data.displayName });
});

api.delete("/addresses/:address", requireScope("addresses:write"), requireAdminConfirmation, async (c) => {
  if (c.get("principal").allowedIdentities !== null) return apiError(c, 403, "Address administration requires an unrestricted administrator key");
  if (!await consumeAdminLimit(c)) return apiError(c, 429, "Administrative rate limit exceeded");
  let decoded: string;
  try { decoded = decodeURIComponent(c.req.param("address")); } catch { return apiError(c, 400, "Invalid address encoding"); }
  const parsed = emailAddress.safeParse(decoded);
  if (!parsed.success) return apiError(c, 400, "Invalid address");
  const address = parsed.data;
  if (address === c.env.OWNER_EMAIL) return apiError(c, 409, "The owner identity cannot be deleted");
  const row = await c.env.DB.prepare("SELECT * FROM identities WHERE address = ?").bind(address).first<IdentityRow>();
  if (!row) return apiError(c, 404, "Address not found");
  await c.env.DB.prepare("UPDATE identities SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE address = ?").bind(address).run();
  await cloudflareRequest(c.env, row.zone_id, `/email/routing/rules/${row.routing_rule_id}`, "DELETE");
  await c.env.DB.prepare("DELETE FROM identities WHERE address = ?").bind(address).run();
  return c.json({ deleted: true, address });
});

api.get("/keys", requireScope("keys:read"), async (c) => {
  const rows = await c.env.DB.prepare(`SELECT id, name, scopes_json, allowed_identities_json, expires_at, revoked_at, created_by, created_at, last_used_at
    FROM api_keys ORDER BY created_at DESC`).all<Omit<ApiKeyRow, "secret_hash">>();
  return c.json({ keys: rows.results.map(publicKey) });
});

api.post("/keys", requireScope("keys:write"), requireAdminConfirmation, async (c) => {
  const input = z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(z.string()).min(1).max(KNOWN_SCOPES.length),
    identities: z.array(emailAddress).max(100).nullable().default(null),
    expiresAt: z.string().datetime().nullable().default(null) }).safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid key request", input.error.flatten());
  if (!await consumeAdminLimit(c)) return apiError(c, 429, "Administrative rate limit exceeded");
  const scopes = [...new Set(input.data.scopes)];
  if (scopes.some((scope) => !KNOWN_SCOPES.includes(scope))) return apiError(c, 400, "Unknown scope", { knownScopes: KNOWN_SCOPES });
  const principal = c.get("principal");
  if (scopes.some((scope) => !hasScope(principal.scopes, scope))) return apiError(c, 403, "Cannot grant a scope you do not possess");
  const identities = input.data.identities === null ? null : [...new Set(input.data.identities)];
  if (principal.allowedIdentities !== null && identities === null) return apiError(c, 403, "A restricted key cannot create an unrestricted key");
  if (scopes.some((scope) => MAIL_SCOPES.has(scope)) && (!identities || identities.length === 0)) {
    return apiError(c, 400, "Mail-scoped keys require at least one explicit identity");
  }
  if (identities?.some((address) => !canAccessIdentity(c, address))) return apiError(c, 403, "Cannot grant an identity you do not possess");
  if (identities) {
    const enabled = await c.env.DB.prepare(`SELECT address FROM identities WHERE enabled = 1 AND address IN (${identities.map(() => "?").join(",")})`)
      .bind(...identities).all<{ address: string }>();
    if (enabled.results.length !== identities.length) return apiError(c, 400, "Every granted identity must be enabled");
  }
  if (input.data.expiresAt && new Date(input.data.expiresAt) <= new Date()) return apiError(c, 400, "Expiry must be in the future");
  const issued = await issueApiKey(c.env, input.data.name, scopes, identities, input.data.expiresAt, principal.keyId);
  return c.json({ ...issued, name: input.data.name, scopes, identities, expiresAt: input.data.expiresAt, warning: "This token is shown once. Store it in a system keychain now." }, 201);
});

api.post("/keys/device", requireScope("keys:write"), requireAdminConfirmation, async (c) => {
  const input = z.object({ name: z.string().trim().min(1).max(100).default("ios-lmail"), identity: emailAddress })
    .safeParse(await c.req.json().catch(() => null));
  if (!input.success) return apiError(c, 400, "Invalid device key request", input.error.flatten());
  if (!await consumeAdminLimit(c)) return apiError(c, 429, "Administrative rate limit exceeded");
  const principal = c.get("principal");
  if (!canAccessIdentity(c, input.data.identity)) return apiError(c, 403, "Cannot grant an identity outside the administrator policy");
  const identity = await c.env.DB.prepare("SELECT address FROM identities WHERE address = ? AND enabled = 1")
    .bind(input.data.identity).first<{ address: string }>();
  if (!identity) return apiError(c, 400, "The device identity must be enabled");
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString();
  const issued = await issueDeviceApiKey(c.env, input.data.name, DEVICE_MAIL_SCOPES, [identity.address], expiresAt, principal.keyId);
  return c.json({ ...issued, name: input.data.name, scopes: DEVICE_MAIL_SCOPES, identities: [identity.address], expiresAt,
    warning: "This one-year device token is shown once. Store it in the device keychain now." }, 201);
});

api.delete("/keys/:id", requireScope("keys:write"), requireAdminConfirmation, async (c) => {
  if (!await consumeAdminLimit(c)) return apiError(c, 429, "Administrative rate limit exceeded");
  if (c.req.param("id") === c.get("principal").keyId) return apiError(c, 409, "Create and verify a replacement before revoking the current key");
  const own = c.get("principal").allowedIdentities;
  if (own !== null) {
    // A restricted key revokes only keys that reach no further than itself: never an administrator's.
    const target = await c.env.DB.prepare("SELECT allowed_identities_json FROM api_keys WHERE id = ? AND revoked_at IS NULL")
      .bind(c.req.param("id")).first<{ allowed_identities_json: string | null }>();
    if (!target) return apiError(c, 404, "Active key not found");
    if (target.allowed_identities_json === null || storedStringArray(target.allowed_identities_json).some((address) => !own.includes(address))) {
      return apiError(c, 403, "A restricted key cannot revoke a key with wider mailbox access");
    }
  }
  const result = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL").bind(c.req.param("id")).run();
  if (!result.meta.changes) return apiError(c, 404, "Active key not found");
  return c.json({ revoked: true, id: c.req.param("id") });
});

api.get("/audit", requireScope("audit:read"), async (c) => {
  const limit = boundedLimit(c.req.query("limit"), 100, 250); const cursor = decodeCursor(c.req.query("cursor"));
  const keyId = c.req.query("keyId"); const action = c.req.query("action");
  if (action && new TextEncoder().encode(action).byteLength > 50) return apiError(c, 400, "Action filter exceeds 50 bytes");
  if (keyId && keyId.length > 64) return apiError(c, 400, "keyId filter exceeds 64 characters");
  const conditions = ["(created_at < ? OR (created_at = ? AND id < ?))"]; const bindings: unknown[] = [cursor.time, cursor.time, cursor.id];
  if (keyId) { conditions.push("key_id = ?"); bindings.push(keyId); }
  if (action) { conditions.push("action LIKE ? ESCAPE '\\'"); bindings.push(`%${action.replaceAll(/[\\%_]/g, "\\$&")}%`); }
  const rows = await c.env.DB.prepare(`SELECT id, request_id, key_id, actor, action, resource, status, ip_hash, user_agent,
    metadata_json, created_at FROM audit_logs WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .bind(...bindings, limit + 1).all<Record<string, unknown>>();
  const hasMore = rows.results.length > limit; const selected = rows.results.slice(0, limit); const last = selected.at(-1);
  return c.json({ events: selected.map((row) => ({ id: row.id, requestId: row.request_id, keyId: row.key_id, actor: row.actor,
    action: row.action, resource: row.resource, status: row.status, ipHash: row.ip_hash, userAgent: row.user_agent,
    metadata: storedJson(row.metadata_json), createdAt: row.created_at })),
    nextCursor: hasMore && last ? encodeCursor(String(last.created_at), String(last.id)) : null });
});

api.onError((error, c) => {
  console.error("API request failed", { requestId: c.get("requestId"), error: String(error) });
  return apiError(c, 500, "Internal server error");
});

function publicMessage(row: MessageRow) {
  return { id: row.id, threadId: row.thread_id, direction: row.direction, folder: row.folder, subject: row.subject,
    sender: { name: row.sender_name, address: row.sender_address, avatarColor: avatarColor(row.sender_address) },
    recipients: publicAddressList(row.recipients_json), preview: row.preview,
    receivedAt: row.received_at, unread: Boolean(row.unread), starred: Boolean(row.starred), hasAttachments: Boolean(row.has_attachments),
    attachmentCount: row.attachment_count, storedAttachmentCount: row.stored_attachment_count,
    attachmentsTruncated: row.stored_attachment_count < row.attachment_count, size: row.size,
    spam: Boolean(row.spam),
    triage: row.triage_category ? { category: row.triage_category, confidence: row.triage_confidence ?? null,
      needsReply: (row.triage_needs_reply ?? 0) >= 0.5, urgency: row.triage_urgency ?? null } : null };
}

function publicRule(row: RuleRow) {
  return { id: row.id, category: row.category, action: row.action, identity: row.identity_address, senderMatch: row.sender_match,
    maxUrgency: row.max_urgency, minConfidence: row.min_confidence, enabled: Boolean(row.enabled), createdAt: row.created_at,
    updatedAt: row.updated_at };
}
function publicAction(row: ActionRow & { sender_name?: string }) {
  return { id: row.id, messageId: row.message_id, ruleId: row.rule_id, action: row.action, detail: row.detail, draftId: row.draft_id,
    subject: row.subject ?? "", sender: { name: row.sender_name ?? "", address: row.sender_address ?? "" }, identity: row.identity_address ?? null,
    createdAt: row.created_at, undoneAt: row.undone_at };
}
function publicIdentity(row: IdentityRow) { return { address: row.address, displayName: row.display_name, avatarColor: avatarColor(row.address),
  zoneId: row.zone_id, routingRuleId: row.routing_rule_id, createdAt: row.created_at }; }
function publicDraft(row: DraftRow) { return { id: row.id, from: row.identity_address, replyToMessageId: row.reply_to_message_id,
  to: storedStringArray(row.recipients_json), cc: storedStringArray(row.cc_json), bcc: storedStringArray(row.bcc_json),
  subject: row.subject, text: row.text_body, updatedAt: row.updated_at }; }
function publicMailboxChange(row: MailboxChangeRow) {
  let payload: unknown = null;
  if (row.payload_json) {
    try { payload = JSON.parse(row.payload_json); } catch { payload = null; }
  }
  if (row.entity_kind === "message") {
    const message = payload && typeof payload === "object" && "status" in payload && payload.status === "ready"
      ? publicMessage(payload as MessageRow) : null;
    return { revision: String(row.revision), kind: "message", id: row.entity_id,
      operation: message ? row.operation : "delete", threadId: row.thread_id,
      previousFolder: row.previous_folder, message };
  }
  const draft = payload && typeof payload === "object" ? publicDraft(payload as DraftRow) : null;
  return { revision: String(row.revision), kind: "draft", id: row.entity_id,
    operation: draft ? row.operation : "delete", threadId: null, previousFolder: null, draft };
}
function publicContact(row: ContactRow) { return { identityAddress: row.identity_address, address: row.address,
  ...(row.display_name ? { displayName: row.display_name } : {}), avatarColor: avatarColor(row.address), source: row.source,
  sendCount: row.send_count, firstSentAt: row.first_sent_at, lastSentAt: row.last_sent_at,
  createdAt: row.created_at, updatedAt: row.updated_at }; }
function publicKey(row: Omit<ApiKeyRow, "secret_hash">) { return { id: row.id, name: row.name, scopes: storedStringArray(row.scopes_json),
  identities: row.allowed_identities_json === null ? null : storedStringArray(row.allowed_identities_json), expiresAt: row.expires_at,
  revokedAt: row.revoked_at, createdBy: row.created_by, createdAt: row.created_at, lastUsedAt: row.last_used_at }; }
async function readObject(bucket: R2Bucket, key: string | null): Promise<string | null> {
  if (!key) return null;
  const object = await bucket.get(key);
  if (!object) return null;
  if (object.size > 5 * 1024 * 1024) return "[body omitted: exceeds 5 MiB API response limit]";
  return object.text();
}
function messageListStatement(env: Env, access: { sql: string; bindings: string[] }, options: {
  folder: string; query: string; limit: number; cursor: { time: string; id: string };
}): D1PreparedStatement {
  const conditions = ["status = 'ready'", access.sql, "(received_at < ? OR (received_at = ? AND id < ?))"];
  const bindings: unknown[] = [...access.bindings, options.cursor.time, options.cursor.time, options.cursor.id];
  if (options.folder === "spam") conditions.push("spam = 1", "folder != 'trash'");
  else {
    conditions.push("spam = 0");
    if (options.folder === "starred") conditions.push("starred = 1", "folder != 'trash'");
    else if (options.folder !== "all") { conditions.push("folder = ?"); bindings.push(options.folder); }
  }
  if (options.query) {
    conditions.push("(subject LIKE ? ESCAPE '\\' OR sender_name LIKE ? ESCAPE '\\' OR sender_address LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')");
    const escaped = `%${options.query.replaceAll(/[\\%_]/g, "\\$&")}%`;
    bindings.push(escaped, escaped, escaped, escaped);
  }
  return env.DB.prepare(`SELECT ${MESSAGE_LIST_COLUMNS} FROM messages
    WHERE ${conditions.join(" AND ")} ORDER BY received_at DESC, id DESC LIMIT ?`)
    .bind(...bindings, options.limit + 1);
}
function mailboxSummaryStatement(env: Env, access: { sql: string; bindings: string[] }): D1PreparedStatement {
  return env.DB.prepare(`SELECT COALESCE(SUM(unread), 0) AS unread, COALESCE(SUM(inbox), 0) AS inbox,
    COALESCE(SUM(sent), 0) AS sent, COALESCE(SUM(starred), 0) AS starred,
    COALESCE(SUM(archive), 0) AS archive, COALESCE(SUM(trash), 0) AS trash,
    COALESCE(SUM(drafts), 0) AS drafts, COALESCE(SUM(spam), 0) AS spam FROM mailbox_counts WHERE ${access.sql}`).bind(...access.bindings);
}
function normalizedSummary(row: MailSummaryRow | null | undefined): MailSummaryRow {
  return { unread: Number(row?.unread ?? 0), inbox: Number(row?.inbox ?? 0), sent: Number(row?.sent ?? 0),
    starred: Number(row?.starred ?? 0), archive: Number(row?.archive ?? 0), trash: Number(row?.trash ?? 0),
    drafts: Number(row?.drafts ?? 0), spam: Number(row?.spam ?? 0) };
}
function identityAccess(c: Context<{ Bindings: Env; Variables: ApiVariables }>, column: string): { sql: string; bindings: string[] } {
  const identities = c.get("principal").allowedIdentities;
  if (identities === null) return { sql: "1 = 1", bindings: [] };
  if (identities.length === 0) return { sql: "0 = 1", bindings: [] };
  return { sql: `${column} IN (${identities.map(() => "?").join(",")})`, bindings: identities };
}
function requestedIdentityAccess(c: Context<{ Bindings: Env; Variables: ApiVariables }>, column: string): { sql: string; bindings: string[] } | null {
  const access = identityAccess(c, column);
  const requested = c.req.query("identity");
  if (!requested) return access;
  const parsed = emailAddress.safeParse(requested);
  if (!parsed.success) return null;
  return { sql: `(${access.sql}) AND ${column} = ?`, bindings: [...access.bindings, parsed.data] };
}
function requestedExactIdentityAccess(c: Context<{ Bindings: Env; Variables: ApiVariables }>, column: string):
  { identity: string; access: { sql: string; bindings: string[] } } | null {
  const requested = c.req.query("identity");
  if (!requested) return null;
  const parsed = emailAddress.safeParse(requested);
  if (!parsed.success || !canAccessIdentity(c, parsed.data)) return null;
  const allowed = identityAccess(c, column);
  return { identity: parsed.data, access: { sql: `(${allowed.sql}) AND ${column} = ?`, bindings: [...allowed.bindings, parsed.data] } };
}
async function mailboxRevision(env: Env, access: { sql: string; bindings: string[] }): Promise<string> {
  const row = await mailboxRevisionStatement(env, access).first<{ revision: number }>();
  return String(row?.revision ?? 0);
}
function mailboxRevisionStatement(env: Env, access: { sql: string; bindings: string[] }): D1PreparedStatement {
  return env.DB.prepare(`SELECT COALESCE(SUM(revision), 0) AS revision
    FROM mailbox_revisions WHERE ${access.sql}`).bind(...access.bindings);
}
function publicAddressList(value: string): Array<{ name?: string; address: string; avatarColor: string }> {
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (typeof item === "string") return [{ address: item, avatarColor: avatarColor(item) }];
    if (typeof item !== "object" || item === null || !("address" in item) || typeof item.address !== "string") return [];
    const name = "name" in item && typeof item.name === "string" ? item.name : undefined;
    return [{ ...(name ? { name } : {}), address: item.address, avatarColor: avatarColor(item.address) }];
  });
}
function storedJson(value: unknown): unknown {
  try { return JSON.parse(String(value)); } catch { return null; }
}
function storedStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
function logoDomain(message: LogoMessage): string | null {
  const address = logoAddress(message);
  const domain = address?.split("@").at(-1)?.toLowerCase().replace(/\.$/, "");
  if (!domain || domain.length > 253 || domain.includes("..") || !/^[a-z0-9.-]+$/.test(domain)) return null;
  return domain;
}
function logoAddress(message: LogoMessage): string | null {
  const address = message.direction === "inbound" ? message.sender_address : publicAddressList(message.recipients_json)[0]?.address;
  const normalized = address?.trim().toLowerCase();
  return normalized && emailAddress.safeParse(normalized).success ? normalized : null;
}
async function authenticateLogoMessage(env: Env, message: LogoMessage, domain: string): Promise<boolean> {
  if (message.sender_authenticated !== null) return message.sender_authenticated === 1;
  const object = await env.MAIL.get(message.raw_key, { range: { offset: 0, length: 65_536 } });
  const headerBytes = object ? await object.arrayBuffer() : null;
  const authenticated = headerBytes !== null
    && senderPassedDmarc(authenticationResultsFromRawHeaders(new TextDecoder().decode(headerBytes)), domain);
  await env.DB.prepare("UPDATE messages SET sender_authenticated = ? WHERE id = ?")
    .bind(authenticated ? 1 : 0, message.id).run();
  return authenticated;
}
function canAccessIdentity(c: Context<{ Bindings: Env; Variables: ApiVariables }>, address: string): boolean {
  const identities = c.get("principal").allowedIdentities;
  return identities === null || identities.includes(address.toLowerCase());
}
async function consumeAdminLimit(c: Context<{ Bindings: Env; Variables: ApiVariables }>): Promise<boolean> {
  return (await c.env.ADMIN_RATE_LIMITER.limit({ key: c.get("principal").keyId })).success;
}
function defaultDisplayName(address: string): string { return address.split("@")[0].split(/[._-]/).filter(Boolean)
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "); }
function boundedLimit(raw: string | undefined, fallback: number, maximum: number): number { const parsed = Number(raw); return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback; }
function booleanQuery(raw: string | undefined): boolean | null {
  if (raw === undefined || raw === "0" || raw === "false") return false;
  if (raw === "1" || raw === "true") return true;
  return null;
}
function encodeCursor(time: string, id: string): string { return btoa(JSON.stringify({ time, id })).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""); }
function decodeCursor(value: string | undefined): { time: string; id: string } {
  if (!value) return { time: "9999-12-31T23:59:59.999Z", id: "~" };
  try { const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(normalized));
    if (typeof parsed === "object" && parsed !== null && "time" in parsed && "id" in parsed && typeof parsed.time === "string" && typeof parsed.id === "string") return parsed as { time: string; id: string };
  } catch { /* invalid cursor falls through */ }
  return { time: "0000-01-01T00:00:00.000Z", id: "" };
}
type DeltaCursor = { since: string; after: string; through: string };
function encodeDeltaCursor(cursor: DeltaCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
function decodeDeltaCursor(value: string | undefined): DeltaCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const parsed: unknown = JSON.parse(atob(normalized));
    if (typeof parsed === "object" && parsed !== null && "since" in parsed && "after" in parsed && "through" in parsed
      && typeof parsed.since === "string" && /^\d+$/.test(parsed.since)
      && typeof parsed.after === "string" && /^\d+$/.test(parsed.after)
      && typeof parsed.through === "string" && /^\d+$/.test(parsed.through)) return parsed as DeltaCursor;
  } catch { /* invalid cursor */ }
  return null;
}
function deltaResetPayload(fromRevision: string, revision: string, reason: string) {
  return { fromRevision, revision, changes: [], hasMore: false, nextCursor: null, resetRequired: true, reason };
}
async function privateJson(c: Context<{ Bindings: Env; Variables: ApiVariables }>, payload: unknown): Promise<Response> {
  const body = JSON.stringify(payload);
  const etag = normalizedEtag(await sha256(body));
  const headers = { "Content-Type": "application/json; charset=UTF-8", "Cache-Control": "private, no-cache", ETag: etag };
  if (requestMatchesEtag(c.req.header("If-None-Match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}
function normalizedEtag(value: string): string {
  const unquoted = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  return `"${unquoted}"`;
}
function requestMatchesEtag(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  return header.split(",").some((candidate) => candidate.trim() === "*" || normalizedEtag(candidate) === etag);
}
function isMessageRow(row: SnapshotDatabaseRow | AttachmentRow | MessageRow): row is MessageRow {
  return "thread_id" in row && "received_at" in row;
}
function isDraftRow(row: SnapshotDatabaseRow): row is DraftRow { return "text_body" in row && "bcc_json" in row; }
function isMailboxChangeRow(row: MailboxChangeRow | MailSummaryRow | { revision: number }): row is MailboxChangeRow {
  return "entity_kind" in row && "entity_id" in row && "operation" in row;
}
function isIdentityRow(row: SnapshotDatabaseRow): row is IdentityRow { return "zone_id" in row && "routing_rule_id" in row; }
function isAttachmentRow(row: AttachmentRow | MessageRow): row is AttachmentRow {
  return "filename" in row && "content_type" in row && "disposition" in row;
}
function apiError(c: Context<{ Bindings: Env; Variables: ApiVariables }>, status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500, error: string, details?: unknown): Response {
  const code = status === 401 ? "unauthorized" : status === 403 ? "forbidden" : status === 404 ? "not_found"
    : status === 409 ? "conflict" : status === 413 ? "payload_too_large" : status === 429 ? "rate_limited"
      : status === 500 ? "internal_error" : "invalid_request";
  if (status === 429) c.header("Retry-After", "60");
  return c.json({ error, code, retryable: status === 429 || status === 500,
    ...(details === undefined ? {} : { details }), requestId: c.get("requestId") }, status);
}

interface CloudflareRoutingRule {
  id: string;
  enabled: boolean;
  matchers: Array<{ type: string; value: string }>;
  actions: Array<{ type: string; value: string[] }>;
}
interface DnsAnswer { data: string; }

async function resolveDns(name: string, type: "MX" | "TXT"): Promise<DnsAnswer[]> {
  const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { Accept: "application/dns-json" },
  });
  if (!response.ok) throw new Error(`DNS lookup failed for ${name}: ${response.status}`);
  const payload = await response.json<{ Status: number; Answer?: DnsAnswer[] }>();
  if (payload.Status !== 0) throw new Error(`DNS lookup failed for ${name}: status ${payload.Status}`);
  return payload.Answer ?? [];
}

async function cloudflareRequest<T>(env: Env, zoneId: string, path: string, method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}${path}`, {
    method, headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json<{ success: boolean; result: T; errors?: Array<{ message: string }> }>();
  if (!response.ok || !payload.success) throw new Error(`Cloudflare API failed: ${payload.errors?.map((item) => item.message).join(", ") || response.status}`);
  return payload.result;
}
