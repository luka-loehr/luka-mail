import { env, exports as workerExports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import type { LanguageModelV3CallOptions, LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, convertArrayToReadableStream } from "ai/test";
import type { AuthPrincipal } from "../src/worker/auth";
import { issueApiKey, issueDeviceApiKey } from "../src/worker/auth";
import { readChat, runChatTurn } from "../src/worker/agent-chat";
import type { Env } from "../src/worker/types";

const workerEnv = env as unknown as Env;
const OWNER = workerEnv.OWNER_EMAIL;
const owner: AuthPrincipal = { keyId: "owner-key", name: "owner", scopes: ["mail:read", "mail:write", "mail:send"], allowedIdentities: null };
const usage = { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } };

/** A model that proposes an email on its first step and answers on the next; records every prompt it saw. */
function scriptedModel(prompts: LanguageModelV3CallOptions["prompt"][], email: Record<string, unknown>, answer: string) {
  let step = 0;
  return new MockLanguageModelV3({
    doStream: async (options) => {
      prompts.push(options.prompt);
      step += 1;
      const parts: LanguageModelV3StreamPart[] = step % 2 === 1
        ? [{ type: "stream-start", warnings: [] },
          { type: "tool-call", toolCallId: `call-${step}`, toolName: "propose_email", input: JSON.stringify(email) },
          { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage }]
        : [{ type: "stream-start", warnings: [] }, { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: answer },
          { type: "text-end", id: "t" }, { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }];
      return { stream: convertArrayToReadableStream(parts) };
    },
  });
}

const titleEnv = { ...workerEnv, AI: { run: async () => ({ choices: [{ message: { content: "„Reply to Alex“" } }], usage: {} }) } } as unknown as Env;

async function events(response: Response | null): Promise<Array<Record<string, unknown>>> {
  return (await response!.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare("DELETE FROM agent_chats"),
    workerEnv.DB.prepare("INSERT OR IGNORE INTO identities (address, display_name, zone_id, routing_rule_id) VALUES (?, 'Owner', 'z', 'r')").bind(OWNER),
  ]);
});

describe("agent chats", () => {
  it("streams a turn with a proposed email, stores it, and titles the chat", async () => {
    const prompts: LanguageModelV3CallOptions["prompt"][] = [];
    const model = scriptedModel(prompts, { from: OWNER, to: ["alex@example.org"], subject: "Tuesday", body: "Hi Alex,\n\nTuesday works.\n\nBest,\nOwner" },
      "Here is a draft.");
    const first = await events(await runChatTurn(titleEnv, owner, { text: "Write Alex that Tuesday works", maxSteps: 4 }, undefined, model));

    expect(first[0]).toMatchObject({ type: "chat" });
    const chatId = first[0]!.chatId as string;
    expect(first.find((event) => event.type === "tool-call")).toMatchObject({ tool: "propose_email", label: "Wrote an email" });
    const draft = first.find((event) => event.type === "draft")!.draft as { id: string; from: string; body: string };
    expect(draft).toMatchObject({ from: OWNER, body: "Hi Alex,\n\nTuesday works.\n\nBest,\nOwner" });
    expect(first.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("Here is a draft.");
    expect(first.at(-1)).toEqual({ type: "title", chatId, title: "Reply to Alex" });

    const stored = await readChat(workerEnv, chatId);
    expect(stored?.chat.title).toBe("Reply to Alex");
    expect(stored?.messages.map((message) => [message.role, message.content, message.error])).toEqual([
      ["user", "Write Alex that Tuesday works", null], ["assistant", "Here is a draft.", null]]);
    expect(stored?.messages[1]?.activity).toEqual([{ tool: "propose_email", label: "Wrote an email" }]);
    expect(stored?.messages[1]?.drafts).toMatchObject([{ id: draft.id, status: "draft", to: ["alex@example.org"] }]);

    // The owner edits the card; the next turn sees the email as it stands now.
    await workerEnv.DB.prepare("UPDATE agent_chat_drafts SET body = 'Hi Alex,\n\nTuesday 11:30 works.\n\nBest,\nOwner' WHERE id = ?").bind(draft.id).run();
    const second = await events(await runChatTurn(titleEnv, owner, { chatId, text: "Make it shorter", maxSteps: 4 }, undefined,
      scriptedModel(prompts, { from: OWNER, to: ["alex@example.org"], subject: "Tuesday", body: "Tuesday 11:30 works. Best, Owner",
        revisesDraftId: draft.id }, "Shorter.")));
    expect(second.some((event) => event.type === "title")).toBe(false);
    const seen = JSON.stringify(prompts.at(-2));
    expect(seen).toContain("Write Alex that Tuesday works");
    expect(seen).toContain("Tuesday 11:30 works.");
    expect(seen).toContain("Make it shorter");
    const drafts = await workerEnv.DB.prepare("SELECT status FROM agent_chat_drafts WHERE chat_id = ? ORDER BY created_at, rowid").bind(chatId)
      .all<{ status: string }>();
    expect(drafts.results.map((row) => row.status)).toEqual(["superseded", "draft"]);
  });

  it("gives the owner's chats every mailbox, whatever the key lists", async () => {
    const seen: string[] = [];
    const model = new MockLanguageModelV3({
      doStream: async (options) => {
        seen.push(JSON.stringify(options.prompt));
        return { stream: convertArrayToReadableStream<LanguageModelV3StreamPart>([{ type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" }, { type: "text-delta", id: "t", delta: "ok" }, { type: "text-end", id: "t" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage }]) };
      },
    });
    const limited: AuthPrincipal = { ...owner, allowedIdentities: [OWNER] };
    await events(await runChatTurn(workerEnv, limited, { text: "Which mailboxes?", maxSteps: 2, fullAccess: true }, undefined, model));
    expect(seen[0]).toContain("external@ext.example.org");
    await events(await runChatTurn(workerEnv, limited, { text: "Which mailboxes?", maxSteps: 2 }, undefined, model));
    expect(seen[1]).not.toContain("external@ext.example.org");
  });

  it("keeps chats to keys for the owner's mailbox and only sends what the owner sends", async () => {
    const model = scriptedModel([], { from: OWNER, to: ["alex@example.org"], subject: "Tuesday", body: "Works." }, "Draft.");
    const turn = await events(await runChatTurn(workerEnv, owner, { text: "Reply to Alex", maxSteps: 4 }, undefined, model));
    const chatId = turn[0]!.chatId as string;
    const draftId = (turn.find((event) => event.type === "draft")!.draft as { id: string }).id;

    const admin = await issueApiKey(workerEnv, "chat-owner", ["mail:read", "mail:write"], null, null, "test");
    const external = await issueDeviceApiKey(workerEnv, "chat-external", ["mail:read", "mail:write", "mail:send"],
      ["external@ext.example.org"], "2099-01-01T00:00:00.000Z", "test");
    const call = (token: string, method: string, path: string, body?: unknown) => workerExports.default.fetch(new Request(
      `https://mail.test/v1${path}`, { method, headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) }));

    expect((await call(external.token, "GET", "/agent/chats")).status).toBe(403);
    const list = await (await call(admin.token, "GET", "/agent/chats")).json() as { chats: Array<{ id: string; preview: string }> };
    expect(list.chats).toMatchObject([{ id: chatId, preview: "Draft." }]);

    const edited = await call(admin.token, "PATCH", `/agent/chats/${chatId}/drafts/${draftId}`, { body: "Works, see you Tuesday!", to: [] });
    expect(await edited.json()).toMatchObject({ draft: { body: "Works, see you Tuesday!", to: [] } });
    // Sending needs the mail:send scope and a recipient.
    expect((await call(admin.token, "POST", `/agent/chats/${chatId}/drafts/${draftId}/send`,
      { idempotencyKey: crypto.randomUUID() })).status).toBe(403);
    const sender = await issueApiKey(workerEnv, "chat-sender", ["mail:read", "mail:write", "mail:send"], null, null, "test");
    const noRecipient = await call(sender.token, "POST", `/agent/chats/${chatId}/drafts/${draftId}/send`, { idempotencyKey: crypto.randomUUID() });
    expect(noRecipient.status).toBe(400);
    await workerEnv.DB.prepare("UPDATE agent_chat_drafts SET status = 'sent' WHERE id = ?").bind(draftId).run();
    expect(await (await call(sender.token, "POST", `/agent/chats/${chatId}/drafts/${draftId}/send`, { idempotencyKey: crypto.randomUUID() })).json())
      .toMatchObject({ sent: true, alreadySent: true });
    // A sent email is no longer editable.
    await call(admin.token, "PATCH", `/agent/chats/${chatId}/drafts/${draftId}`, { body: "changed" });
    expect((await readChat(workerEnv, chatId))?.messages[1]?.drafts[0]?.body).toBe("Works, see you Tuesday!");

    expect((await call(admin.token, "DELETE", `/agent/chats/${chatId}`)).status).toBe(200);
    expect(await workerEnv.DB.prepare("SELECT COUNT(*) AS count FROM agent_chat_drafts").first()).toEqual({ count: 0 });
  });
});
