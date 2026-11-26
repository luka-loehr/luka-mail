import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { MockLanguageModelV3 } from "ai/test";
import { ingestExternalMessage } from "../src/worker/external";
import { graphLookup, kgStatus, parseExtraction, runKnowledgeGraphSync, semanticSearch } from "../src/worker/kg";
import type { Env } from "../src/worker/types";

const EXTERNAL = "external@ext.example.org";
const OWNER = "owner@example.com";
const encoder = new TextEncoder();

class FakeVectorize {
  upserts: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
  deleted: string[] = [];
  queryResponse: Array<{ id: string; score: number }> = [];

  async upsert(vectors: Array<{ id: string; values: number[]; metadata?: Record<string, unknown> }>): Promise<void> {
    for (const vector of vectors) this.upserts.push({ id: vector.id, metadata: vector.metadata });
  }

  async deleteByIds(ids: string[]): Promise<void> {
    this.deleted.push(...ids);
  }

  async query(): Promise<{ matches: Array<{ id: string; score: number }> }> {
    return { matches: this.queryResponse };
  }
}

const fakeAi = { run: async () => ({ data: [[0.1, 0.2, 0.3]] }) };

const EXTRACTION_REPLY = [
  "Sure, here is the JSON:",
  "```json",
  JSON.stringify({
    gist: "Jordan Rivera from Acme Club reimburses 99 EUR for the developer account upon receipt.",
    entities: [
      { name: "Jordan Rivera", kind: "person" },
      { name: "Acme Club", kind: "organization" },
      { name: "99 EUR", kind: "amount" },
      { name: "Developer Account", kind: "UnknownKind" },
    ],
    relations: [
      { subject: "Acme Club", relation: "reimburses", object: "99 EUR" },
      { subject: "Jordan Rivera", relation: "belongs to", object: "Acme Club" },
      { subject: "Jordan Rivera", relation: "knows", object: "Unknown Entity" },
    ],
  }),
  "```",
].join("\n");

function mockExtractionModel(): LanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text: EXTRACTION_REPLY }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 500, noCache: 500, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

function kgEnv(vectorize: FakeVectorize): Env {
  return { ...(env as unknown as Env), AI: fakeAi, VECTORIZE: vectorize } as unknown as Env;
}

async function seedMessage(subject: string): Promise<string> {
  const raw = [
    "From: Jordan Rivera <treasurer@ext.example.org>",
    `To: ${EXTERNAL}`,
    `Subject: ${subject}`,
    "Date: Mon, 17 Aug 2026 10:00:00 +0200",
    `Message-ID: <${subject.replaceAll(/\s+/g, "-")}@imap.test>`,
    "",
    "Acme Club reimburses 99 EUR for the developer account upon receipt.",
    "",
  ].join("\r\n");
  await ingestExternalMessage(env as unknown as Env, {
    identity: EXTERNAL, localFolder: "inbox", externalFolder: null,
    raw: encoder.encode(raw), seen: true, flagged: false,
    fallbackReceivedAt: new Date().toISOString(), suppressPush: true,
  });
  const row = await (env as unknown as Env).DB.prepare("SELECT id FROM messages WHERE subject = ?")
    .bind(subject).first<{ id: string }>();
  return row!.id;
}

beforeEach(async () => {
  const db = (env as unknown as Env).DB;
  await db.batch([
    db.prepare("DELETE FROM attachments"),
    // Deleting messages fires the vector-deletion trigger, so the queue is
    // cleared afterwards to give each test a clean slate.
    db.prepare("DELETE FROM messages"),
    db.prepare("DELETE FROM kg_edges"),
    db.prepare("DELETE FROM kg_mentions"),
    db.prepare("DELETE FROM kg_entities"),
    db.prepare("DELETE FROM message_gists"),
    db.prepare("DELETE FROM kg_state"),
    db.prepare("DELETE FROM kg_vector_deletions"),
    db.prepare("DELETE FROM push_notification_outbox"),
  ]);
});

describe("knowledge graph pipeline", () => {
  it("queues every ready message via trigger and indexes it end to end", async () => {
    const messageId = await seedMessage("Acme Club Reimbursement");
    const db = (env as unknown as Env).DB;
    const queued = await db.prepare("SELECT embed_status, extract_status FROM kg_state WHERE message_id = ?")
      .bind(messageId).first<{ embed_status: string; extract_status: string }>();
    expect(queued).toEqual({ embed_status: "pending", extract_status: "pending" });

    const vectorize = new FakeVectorize();
    const report = await runKnowledgeGraphSync(kgEnv(vectorize), { model: mockExtractionModel() });
    expect(report.embedded).toBe(1);
    expect(report.extracted).toBe(1);
    expect(report.done).toBe(true);
    expect(vectorize.upserts).toHaveLength(1);
    expect(vectorize.upserts[0].id).toBe(messageId);
    expect(vectorize.upserts[0].metadata).toMatchObject({ identity: EXTERNAL });

    const gist = await db.prepare("SELECT gist FROM message_gists WHERE message_id = ?")
      .bind(messageId).first<{ gist: string }>();
    expect(gist?.gist).toContain("99 EUR");
    const entities = await db.prepare("SELECT name, kind FROM kg_entities ORDER BY name").all<{ name: string; kind: string }>();
    expect(entities.results.map((entity) => entity.name)).toEqual(["99 EUR", "Acme Club", "Developer Account", "Jordan Rivera"]);
    expect(entities.results.find((entity) => entity.name === "Developer Account")?.kind).toBe("other");
    const edges = await db.prepare("SELECT COUNT(*) AS count FROM kg_edges").first<{ count: number }>();
    expect(edges?.count).toBe(2);
    const state = await db.prepare("SELECT embed_status, extract_status FROM kg_state WHERE message_id = ?")
      .bind(messageId).first<{ embed_status: string; extract_status: string }>();
    expect(state).toEqual({ embed_status: "done", extract_status: "done" });
  });

  it("is idempotent and reports done with an empty queue", async () => {
    await seedMessage("Nochmal");
    const vectorize = new FakeVectorize();
    await runKnowledgeGraphSync(kgEnv(vectorize), { model: mockExtractionModel() });
    const second = await runKnowledgeGraphSync(kgEnv(vectorize), { model: mockExtractionModel() });
    expect(second.embedded).toBe(0);
    expect(second.extracted).toBe(0);
    expect(second.done).toBe(true);
  });

  it("drains vector deletions queued by the message delete trigger", async () => {
    const messageId = await seedMessage("Wird gelöscht");
    const vectorize = new FakeVectorize();
    const testEnv = kgEnv(vectorize);
    await runKnowledgeGraphSync(testEnv, { model: mockExtractionModel() });
    await testEnv.DB.prepare("DELETE FROM messages WHERE id = ?").bind(messageId).run();

    const queued = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM kg_vector_deletions").first<{ count: number }>();
    expect(queued?.count).toBe(1);
    const orphanGists = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM message_gists").first<{ count: number }>();
    expect(orphanGists?.count).toBe(0);

    const report = await runKnowledgeGraphSync(testEnv, { model: mockExtractionModel() });
    expect(report.deletionsProcessed).toBe(1);
    expect(vectorize.deleted).toEqual([messageId]);
    const drained = await testEnv.DB.prepare("SELECT COUNT(*) AS count FROM kg_vector_deletions").first<{ count: number }>();
    expect(drained?.count).toBe(0);
  });

  it("answers semantic search with gists and enforces identity access", async () => {
    const messageId = await seedMessage("Semantisch");
    const vectorize = new FakeVectorize();
    const testEnv = kgEnv(vectorize);
    await runKnowledgeGraphSync(testEnv, { model: mockExtractionModel() });
    vectorize.queryResponse = [{ id: messageId, score: 0.87 }];

    const results = await semanticSearch(testEnv, [EXTERNAL], { query: "developer reimbursement", topK: 5 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: messageId, identity: EXTERNAL, score: 0.87 });
    expect(results[0].gist).toContain("99 EUR");

    const denied = await semanticSearch(testEnv, [OWNER], { query: "developer reimbursement", topK: 5 });
    expect(denied).toHaveLength(0);
  });

  it("looks up entities with relations and related messages", async () => {
    await seedMessage("Graphsuche");
    const vectorize = new FakeVectorize();
    const testEnv = kgEnv(vectorize);
    await runKnowledgeGraphSync(testEnv, { model: mockExtractionModel() });

    const lookup = await graphLookup(testEnv, [EXTERNAL], { entity: "acme club" }) as {
      entities: Array<{ name: string }>;
      relations: Array<{ subject: string; relation: string; object: string }>;
      relatedMessages: Array<{ subject: string; gist: string | null }>;
    };
    expect(lookup.entities.map((entity) => entity.name)).toContain("Acme Club");
    expect(lookup.relations).toContainEqual({ subject: "Acme Club", relation: "reimburses", object: "99 EUR" });
    expect(lookup.relatedMessages[0]?.gist).toContain("99 EUR");

    const status = await kgStatus(testEnv) as { entities: number; relations: number };
    expect(status.entities).toBe(4);
    expect(status.relations).toBe(2);
  });

  it("parses extraction replies with fences and prose around the JSON", () => {
    const parsed = parseExtraction(EXTRACTION_REPLY);
    expect(parsed.gist).toContain("Acme Club");
    expect(parsed.entities).toHaveLength(4);
    expect(() => parseExtraction("no json here")).toThrow();
  });
});
