// The mail knowledge graph: every ready message is embedded into Vectorize
// for semantic search and mined (LLM extraction) into entities, relations,
// and a short gist in D1. The work queue (kg_state) and the vector-deletion
// queue are populated by D1 triggers, so the graph maintains itself — new
// mail, sends, and deletions all flow through with no manual bookkeeping.

import { generateText, type LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { stableId } from "./crypto";
import type { Env, MessageRow } from "./types";
import { recordAiRun, type RunUsage } from "./usage";

const EMBEDDING_MODEL = "@cf/baai/bge-m3";
// Extraction is structured mining, not reasoning: a fast instruct model emits
// the JSON immediately instead of thinking out loud first.
const DEFAULT_KG_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const MAX_EMBED_CHARS = 6_000;
const MAX_EXTRACT_CHARS = 4_000;
const MAX_ATTEMPTS = 5;
const SYNC_CONCURRENCY = 4;
const ENTITY_KINDS = new Set(["person", "organization", "project", "topic", "amount", "date", "document", "place", "other"]);

export interface KgSyncOptions {
  maxMessages?: number;
  deadlineMs?: number;
  model?: LanguageModel;
}

export interface KgSyncReport {
  deletionsProcessed: number;
  embedded: number;
  extracted: number;
  failed: number;
  remaining: number;
  done: boolean;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

type KgQueueRow = Pick<MessageRow, "id" | "subject" | "sender_name" | "sender_address" | "recipients_json"
  | "identity_address" | "folder" | "received_at" | "text_key" | "html_key" | "preview"> & {
    embed_status: string;
    extract_status: string;
    attempts: number;
  };

const extractionSchema = z.object({
  gist: z.string().min(1).max(600),
  entities: z.array(z.object({
    name: z.string().min(1).max(120),
    kind: z.string().min(1).max(40),
  })).max(12).default([]),
  relations: z.array(z.object({
    subject: z.string().min(1).max(120),
    relation: z.string().min(1).max(80),
    object: z.string().min(1).max(120),
  })).max(10).default([]),
});

export async function runKnowledgeGraphSync(env: Env, options: KgSyncOptions = {}): Promise<KgSyncReport> {
  const startedAt = Date.now();
  const deadline = Date.now() + (options.deadlineMs ?? 60_000);
  const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 25, 100));
  const report: KgSyncReport = { deletionsProcessed: 0, embedded: 0, extracted: 0, failed: 0,
    remaining: 0, done: false, inputTokens: 0, outputTokens: 0, costUsd: 0 };

  report.deletionsProcessed = await drainVectorDeletions(env);

  const queue = await env.DB.prepare(`SELECT m.id, m.subject, m.sender_name, m.sender_address, m.recipients_json,
      m.identity_address, m.folder, m.received_at, m.text_key, m.html_key, m.preview,
      ks.embed_status, ks.extract_status, ks.attempts
    FROM kg_state ks JOIN messages m ON m.id = ks.message_id
    WHERE m.status = 'ready' AND ks.attempts < ?
      AND (ks.embed_status = 'pending' OR ks.extract_status = 'pending')
    ORDER BY m.received_at DESC LIMIT ?`).bind(MAX_ATTEMPTS, maxMessages).all<KgQueueRow>();

  const modelName = kgModelName(env);
  const model = options.model ?? defaultExtractionModel(env, modelName);
  const rows = queue.results;
  const usage: RunUsage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
  let index = 0;
  while (index < rows.length && Date.now() < deadline) {
    const group = rows.slice(index, index + SYNC_CONCURRENCY);
    index += group.length;
    await Promise.all(group.map((row) => processQueueRow(env, model, row, deadline, report, usage)));
  }
  report.inputTokens = usage.inputTokens;
  report.outputTokens = usage.outputTokens;
  if (usage.inputTokens > 0 || usage.outputTokens > 0) {
    const cost = await recordAiRun(env, { kind: "kg-sync", keyId: null, model: modelName,
      prompt: null, identity: null, toolCalls: report.extracted, usage,
      durationMs: Date.now() - startedAt });
    report.costUsd = cost.costUsd;
  }

  const remaining = await env.DB.prepare(`SELECT COUNT(*) AS count FROM kg_state ks JOIN messages m ON m.id = ks.message_id
    WHERE m.status = 'ready' AND ks.attempts < ? AND (ks.embed_status = 'pending' OR ks.extract_status = 'pending')`)
    .bind(MAX_ATTEMPTS).first<{ count: number }>();
  report.remaining = remaining?.count ?? 0;
  report.done = report.remaining === 0;
  return report;
}

async function processQueueRow(env: Env, model: LanguageModel, row: KgQueueRow,
  deadline: number, report: KgSyncReport, usage: RunUsage): Promise<void> {
  try {
    const body = await loadMessageText(env, row);
    if (row.embed_status === "pending") {
      await embedMessage(env, row, body);
      report.embedded += 1;
    }
    if (row.extract_status === "pending" && Date.now() < deadline) {
      const spent = await extractMessage(env, model, row, body);
      usage.inputTokens += spent.inputTokens;
      usage.cachedInputTokens += spent.cachedInputTokens;
      usage.outputTokens += spent.outputTokens;
      report.extracted += 1;
    }
    await env.DB.prepare("UPDATE kg_state SET last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE message_id = ?")
      .bind(row.id).run();
  } catch (error) {
    report.failed += 1;
    const attempts = row.attempts + 1;
    await env.DB.prepare(`UPDATE kg_state SET attempts = ?, last_error = ?,
      embed_status = CASE WHEN embed_status = 'pending' AND ? >= ${MAX_ATTEMPTS} THEN 'failed' ELSE embed_status END,
      extract_status = CASE WHEN extract_status = 'pending' AND ? >= ${MAX_ATTEMPTS} THEN 'failed' ELSE extract_status END,
      updated_at = CURRENT_TIMESTAMP WHERE message_id = ?`)
      .bind(attempts, String(error).slice(0, 400), attempts, attempts, row.id).run();
  }
}

async function drainVectorDeletions(env: Env): Promise<number> {
  const rows = await env.DB.prepare("SELECT message_id FROM kg_vector_deletions ORDER BY created_at LIMIT 100")
    .all<{ message_id: string }>();
  if (rows.results.length === 0) return 0;
  const ids = rows.results.map((row) => row.message_id);
  await env.VECTORIZE.deleteByIds(ids);
  await env.DB.prepare(`DELETE FROM kg_vector_deletions WHERE message_id IN (${ids.map(() => "?").join(",")})`)
    .bind(...ids).run();
  return ids.length;
}

async function loadMessageText(env: Env, row: KgQueueRow): Promise<string> {
  if (row.text_key) {
    const object = await env.MAIL.get(row.text_key);
    if (object) return object.text();
  }
  if (row.html_key) {
    const object = await env.MAIL.get(row.html_key);
    if (object) {
      const html = await object.text();
      return html.replaceAll(/<style[\s\S]*?<\/style>/gi, " ").replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim();
    }
  }
  return row.preview || row.subject;
}

async function embedMessage(env: Env, row: KgQueueRow, body: string): Promise<void> {
  const content = `${row.subject}\n\n${body}`.slice(0, MAX_EMBED_CHARS);
  const vector = await embedText(env, content);
  await env.VECTORIZE.upsert([{
    id: row.id,
    values: vector,
    metadata: {
      identity: row.identity_address ?? "",
      sender: row.sender_address,
      receivedAt: row.received_at,
    },
  }]);
  await env.DB.prepare("UPDATE kg_state SET embed_status = 'done', updated_at = CURRENT_TIMESTAMP WHERE message_id = ?")
    .bind(row.id).run();
}

export async function embedText(env: Env, text: string): Promise<number[]> {
  const response = await env.AI.run(EMBEDDING_MODEL as Parameters<Ai["run"]>[0],
    { text: [text.slice(0, MAX_EMBED_CHARS)] }) as { data?: number[][] };
  const vector = response.data?.[0];
  if (!vector || vector.length === 0) throw new Error("Embedding model returned no vector");
  return vector;
}

function kgModelName(env: Env): string {
  return (env as unknown as Record<string, string | undefined>).KG_MODEL || DEFAULT_KG_MODEL;
}

function defaultExtractionModel(env: Env, name: string): LanguageModel {
  const workersai = createWorkersAI({ binding: env.AI });
  return workersai(name as Parameters<typeof workersai>[0]);
}

const EXTRACT_SYSTEM = [
  "You mine emails into a compact knowledge-graph record. Reply with ONLY a JSON object, no prose, no code fences:",
  `{"gist": "...", "entities": [{"name": "...", "kind": "person|organization|project|topic|amount|date|document|place|other"}], "relations": [{"subject": "...", "relation": "...", "object": "..."}]}`,
  "gist: 1-2 sentences in the email's own language stating what it is about and any action/commitment.",
  "entities: at most 8 — the people and organizations involved, projects/topics, concrete amounts, deadlines, and named documents.",
  "relations: at most 6 — subject and object MUST exactly match entity names; relation is a short verb phrase (e.g. 'erstattet', 'requests invoice from', 'betrifft').",
].join("\n");

async function extractMessage(env: Env, model: LanguageModel, row: KgQueueRow, body: string): Promise<RunUsage> {
  const prompt = [
    `From: ${row.sender_name ? `${row.sender_name} <${row.sender_address}>` : row.sender_address}`,
    `To: ${addressList(row.recipients_json)}`,
    `Mailbox: ${row.identity_address ?? "?"} (${row.folder})`,
    `Date: ${row.received_at}`,
    `Subject: ${row.subject}`,
    "",
    body.slice(0, MAX_EXTRACT_CHARS),
  ].join("\n");
  const result = await generateText({ model, system: EXTRACT_SYSTEM, prompt,
    maxOutputTokens: 900, timeout: { totalMs: 60_000 } });
  const record = parseExtraction(result.text);

  const statements: D1PreparedStatement[] = [];
  const entityIds = new Map<string, string>();
  for (const entity of record.entities) {
    const kind = normalizeKind(entity.kind);
    const name = entity.name.trim();
    const id = await stableId(`entity:${kind}:${name.toLowerCase()}`);
    entityIds.set(name.toLowerCase(), id);
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO kg_entities (id, name, kind) VALUES (?, ?, ?)")
      .bind(id, name, kind));
    statements.push(env.DB.prepare("INSERT OR IGNORE INTO kg_mentions (message_id, entity_id) VALUES (?, ?)")
      .bind(row.id, id));
  }
  statements.push(env.DB.prepare("DELETE FROM kg_edges WHERE message_id = ?").bind(row.id));
  for (const relation of record.relations) {
    const subjectId = entityIds.get(relation.subject.trim().toLowerCase());
    const objectId = entityIds.get(relation.object.trim().toLowerCase());
    if (!subjectId || !objectId || subjectId === objectId) continue;
    const edgeId = await stableId(`edge:${row.id}:${subjectId}:${relation.relation}:${objectId}`);
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO kg_edges (id, message_id, subject_entity_id, relation, object_entity_id)
      VALUES (?, ?, ?, ?, ?)`).bind(edgeId, row.id, subjectId, relation.relation.trim(), objectId));
  }
  statements.push(env.DB.prepare(`INSERT INTO message_gists (message_id, gist) VALUES (?, ?)
    ON CONFLICT(message_id) DO UPDATE SET gist = excluded.gist`).bind(row.id, record.gist.trim()));
  statements.push(env.DB.prepare("UPDATE kg_state SET extract_status = 'done', updated_at = CURRENT_TIMESTAMP WHERE message_id = ?")
    .bind(row.id));
  await env.DB.batch(statements);
  return {
    inputTokens: result.totalUsage.inputTokens ?? 0,
    cachedInputTokens: result.totalUsage.inputTokenDetails.cacheReadTokens ?? 0,
    outputTokens: result.totalUsage.outputTokens ?? 0,
  };
}

export function parseExtraction(text: string): z.infer<typeof extractionSchema> {
  const cleaned = text.replaceAll(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("Extraction reply contained no JSON object");
  return extractionSchema.parse(JSON.parse(cleaned.slice(start, end + 1)));
}

function normalizeKind(kind: string): string {
  const normalized = kind.trim().toLowerCase();
  return ENTITY_KINDS.has(normalized) ? normalized : "other";
}

function addressList(value: string): string {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return "";
    return parsed.flatMap((item) => typeof item === "object" && item !== null && "address" in item
      && typeof item.address === "string" ? [item.address] : []).slice(0, 5).join(", ");
  } catch {
    return "";
  }
}

export interface SemanticSearchInput {
  query: string;
  identity?: string;
  topK: number;
}

export interface SemanticSearchResult {
  id: string;
  score: number;
  identity: string | null;
  folder: string;
  from: string;
  subject: string;
  gist: string | null;
  receivedAt: string;
}

export async function semanticSearch(env: Env, allowedIdentities: string[] | null,
  input: SemanticSearchInput): Promise<SemanticSearchResult[]> {
  const vector = await embedText(env, input.query);
  const matches = await env.VECTORIZE.query(vector, {
    topK: Math.max(1, Math.min(input.topK, 15)),
    ...(input.identity ? { filter: { identity: input.identity } } : {}),
  });
  const ids = matches.matches.map((match) => match.id);
  if (ids.length === 0) return [];
  const access = accessClause(allowedIdentities, "m.identity_address", input.identity);
  const rows = await env.DB.prepare(`SELECT m.id, m.identity_address, m.folder, m.subject, m.sender_name,
      m.sender_address, m.received_at, g.gist
    FROM messages m LEFT JOIN message_gists g ON g.message_id = m.id
    WHERE m.id IN (${ids.map(() => "?").join(",")}) AND m.status = 'ready' AND ${access.sql}`)
    .bind(...ids, ...access.bindings)
    .all<Pick<MessageRow, "id" | "identity_address" | "folder" | "subject" | "sender_name" | "sender_address" | "received_at"> & { gist: string | null }>();
  const scores = new Map(matches.matches.map((match) => [match.id, match.score]));
  return rows.results
    .map((row) => ({
      id: row.id,
      score: Math.round((scores.get(row.id) ?? 0) * 1000) / 1000,
      identity: row.identity_address,
      folder: row.folder,
      from: row.sender_name ? `${row.sender_name} <${row.sender_address}>` : row.sender_address,
      subject: row.subject,
      gist: row.gist,
      receivedAt: row.received_at,
    }))
    .sort((left, right) => right.score - left.score);
}

export interface GraphLookupInput {
  entity?: string;
  messageId?: string;
}

export async function graphLookup(env: Env, allowedIdentities: string[] | null,
  input: GraphLookupInput): Promise<unknown> {
  const access = accessClause(allowedIdentities, "m.identity_address");
  if (input.messageId) {
    const entities = await env.DB.prepare(`SELECT e.id, e.name, e.kind FROM kg_mentions km
      JOIN kg_entities e ON e.id = km.entity_id
      JOIN messages m ON m.id = km.message_id
      WHERE km.message_id = ? AND ${access.sql} ORDER BY e.kind, e.name LIMIT 20`)
      .bind(input.messageId, ...access.bindings).all<{ id: string; name: string; kind: string }>();
    const edges = await messageEdges(env, [input.messageId]);
    const related = entities.results.length
      ? await relatedMessages(env, access, entities.results.map((entity) => entity.id), input.messageId)
      : [];
    return {
      entities: entities.results.map((entity) => ({ name: entity.name, kind: entity.kind })),
      relations: edges,
      relatedMessages: related,
    };
  }
  if (!input.entity) return { error: "Provide entity or messageId" };
  const escaped = `%${input.entity.trim().toLowerCase().replaceAll(/[\\%_]/g, "\\$&")}%`;
  const entities = await env.DB.prepare(`SELECT id, name, kind FROM kg_entities
    WHERE lower(name) LIKE ? ESCAPE '\\' ORDER BY length(name) LIMIT 5`)
    .bind(escaped).all<{ id: string; name: string; kind: string }>();
  if (entities.results.length === 0) return { entities: [], relations: [], relatedMessages: [] };
  const entityIds = entities.results.map((entity) => entity.id);
  const edges = await entityEdges(env, access, entityIds);
  const related = await relatedMessages(env, access, entityIds, null);
  return {
    entities: entities.results.map((entity) => ({ name: entity.name, kind: entity.kind })),
    relations: edges,
    relatedMessages: related,
  };
}

async function messageEdges(env: Env, messageIds: string[]): Promise<Array<{ subject: string; relation: string; object: string }>> {
  const rows = await env.DB.prepare(`SELECT s.name AS subject, e.relation, o.name AS object FROM kg_edges e
    JOIN kg_entities s ON s.id = e.subject_entity_id
    JOIN kg_entities o ON o.id = e.object_entity_id
    WHERE e.message_id IN (${messageIds.map(() => "?").join(",")}) LIMIT 25`)
    .bind(...messageIds).all<{ subject: string; relation: string; object: string }>();
  return rows.results;
}

async function entityEdges(env: Env, access: { sql: string; bindings: string[] },
  entityIds: string[]): Promise<Array<{ subject: string; relation: string; object: string }>> {
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT DISTINCT s.name AS subject, e.relation, o.name AS object FROM kg_edges e
    JOIN kg_entities s ON s.id = e.subject_entity_id
    JOIN kg_entities o ON o.id = e.object_entity_id
    JOIN messages m ON m.id = e.message_id
    WHERE (e.subject_entity_id IN (${placeholders}) OR e.object_entity_id IN (${placeholders})) AND ${access.sql}
    LIMIT 25`).bind(...entityIds, ...entityIds, ...access.bindings)
    .all<{ subject: string; relation: string; object: string }>();
  return rows.results;
}

async function relatedMessages(env: Env, access: { sql: string; bindings: string[] },
  entityIds: string[], excludeMessageId: string | null): Promise<unknown[]> {
  const placeholders = entityIds.map(() => "?").join(",");
  const rows = await env.DB.prepare(`SELECT DISTINCT m.id, m.identity_address, m.folder, m.subject,
      m.sender_name, m.sender_address, m.received_at, g.gist
    FROM kg_mentions km
    JOIN messages m ON m.id = km.message_id
    LEFT JOIN message_gists g ON g.message_id = m.id
    WHERE km.entity_id IN (${placeholders}) AND m.status = 'ready' AND ${access.sql}
      ${excludeMessageId ? "AND m.id != ?" : ""}
    ORDER BY m.received_at DESC LIMIT 10`)
    .bind(...entityIds, ...access.bindings, ...(excludeMessageId ? [excludeMessageId] : []))
    .all<Pick<MessageRow, "id" | "identity_address" | "folder" | "subject" | "sender_name" | "sender_address" | "received_at"> & { gist: string | null }>();
  return rows.results.map((row) => ({
    id: row.id,
    identity: row.identity_address,
    folder: row.folder,
    from: row.sender_name ? `${row.sender_name} <${row.sender_address}>` : row.sender_address,
    subject: row.subject,
    gist: row.gist,
    receivedAt: row.received_at,
  }));
}

export async function kgStatus(env: Env): Promise<unknown> {
  const [state, entities, edges, gists, deletions] = await env.DB.batch<Record<string, number>>([
    env.DB.prepare(`SELECT
      COALESCE(SUM(CASE WHEN embed_status = 'pending' THEN 1 ELSE 0 END), 0) AS embed_pending,
      COALESCE(SUM(CASE WHEN embed_status = 'done' THEN 1 ELSE 0 END), 0) AS embed_done,
      COALESCE(SUM(CASE WHEN extract_status = 'pending' THEN 1 ELSE 0 END), 0) AS extract_pending,
      COALESCE(SUM(CASE WHEN extract_status = 'done' THEN 1 ELSE 0 END), 0) AS extract_done,
      COALESCE(SUM(CASE WHEN embed_status = 'failed' OR extract_status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
      FROM kg_state`),
    env.DB.prepare("SELECT COUNT(*) AS count FROM kg_entities"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM kg_edges"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM message_gists"),
    env.DB.prepare("SELECT COUNT(*) AS count FROM kg_vector_deletions"),
  ]);
  return {
    messages: state.results[0],
    entities: entities.results[0]?.count ?? 0,
    relations: edges.results[0]?.count ?? 0,
    gists: gists.results[0]?.count ?? 0,
    pendingVectorDeletions: deletions.results[0]?.count ?? 0,
  };
}

function accessClause(allowed: string[] | null, column: string, requested?: string): { sql: string; bindings: string[] } {
  if (requested) {
    const identity = requested.toLowerCase();
    if (allowed !== null && !allowed.includes(identity)) return { sql: "0 = 1", bindings: [] };
    return { sql: `${column} = ?`, bindings: [identity] };
  }
  if (allowed === null) return { sql: "1 = 1", bindings: [] };
  if (allowed.length === 0) return { sql: "0 = 1", bindings: [] };
  return { sql: `${column} IN (${allowed.map(() => "?").join(",")})`, bindings: allowed };
}
