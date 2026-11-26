// The mail agent: a Vercel AI SDK tool loop running on Workers AI. It is
// deliberately confined to mailbox tools — no filesystem, network, or code
// execution surface — and every tool enforces the caller's identity policy
// and scopes exactly like the REST API does. It cannot send: an email it
// writes is proposed as a draft that the owner edits and sends himself.

import { generateText, stepCountIs, streamText, tool, type LanguageModel, type LanguageModelUsage, type ModelMessage, type ToolSet } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import { hasScope, type AuthPrincipal } from "./auth";
import { appName, ownerName } from "./config";
import { graphLookup, semanticSearch } from "./kg";
import { signedForIdentity, styleGuide } from "./owner-profile";
import { earlierMails } from "./reply-drafts";
import { listRules, readAutopilotSettings, undoAction, type ActionRow } from "./autopilot";
import type { ContactRow, Env, MessageRow } from "./types";
import { dailyNeurons, recordAiRun, type DailyNeurons, type RunUsage } from "./usage";

const DEFAULT_MODEL = "@cf/zai-org/glm-5.3-flash";
const FOLDERS = ["inbox", "sent", "archive", "trash", "starred", "all"] as const;
const MUTABLE_FOLDERS = ["inbox", "sent", "archive", "trash"] as const;
const MAX_BODY_CHARS = 12_000;

export interface AgentRunRequest {
  prompt: string;
  identity?: string;
  maxSteps: number;
}

export interface AgentRunResult {
  text: string;
  model: string;
  toolCalls: Array<{ tool: string; input: unknown }>;
  drafts: ProposedEmail[];
  usage: RunUsage;
  neurons: number;
  costUsd: number;
  dailyNeurons: DailyNeurons;
}

function usageFrom(total: LanguageModelUsage): RunUsage {
  return {
    inputTokens: total.inputTokens ?? 0,
    cachedInputTokens: total.inputTokenDetails.cacheReadTokens ?? 0,
    outputTokens: total.outputTokens ?? 0,
  };
}

export interface AgentContext {
  env: Env;
  principal: AuthPrincipal;
  requestedIdentity?: string;
  // Set when the run belongs to a saved chat: proposed emails are stored there.
  chat?: { chatId: string; messageId: string };
}

export interface ProposedEmail {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  body: string;
  replyToMessageId: string | null;
  revisesDraftId: string | null;
  status: "draft";
}

export interface ActivityItem {
  tool: string;
  label: string;
}

export interface SourceItem {
  id: string;
  subject: string;
  from: string;
  receivedAt: string;
  identity: string | null;
  read: boolean;
}

interface PreparedAgentRun {
  model: LanguageModel;
  modelName: string;
  system: string;
  tools: ToolSet;
  maxSteps: number;
}

async function prepareAgentRun(env: Env, principal: AuthPrincipal, request: AgentRunRequest,
  modelOverride?: LanguageModel, chat?: AgentContext["chat"]): Promise<PreparedAgentRun> {
  const context: AgentContext = { env, principal, requestedIdentity: request.identity, chat };
  const identities = await accessibleIdentities(context);
  if (identities.length === 0) throw new Error("No accessible mail identity for this credential");
  const modelName = env.AGENT_MODEL || DEFAULT_MODEL;
  const workersAiModel = (): LanguageModel => {
    const workersai = createWorkersAI({ binding: env.AI });
    return workersai(modelName as Parameters<typeof workersai>[0]);
  };
  return {
    model: modelOverride ?? workersAiModel(),
    modelName,
    system: systemPrompt(env, identities, request),
    tools: buildAgentTools(context),
    maxSteps: Math.min(Math.max(request.maxSteps, 1), 16),
  };
}

export async function runMailAgent(env: Env, principal: AuthPrincipal, request: AgentRunRequest): Promise<AgentRunResult> {
  const startedAt = Date.now();
  const prepared = await prepareAgentRun(env, principal, request);
  const toolCalls: AgentRunResult["toolCalls"] = [];
  const drafts: ProposedEmail[] = [];
  const result = await generateText({
    model: prepared.model,
    system: prepared.system,
    prompt: request.prompt,
    tools: prepared.tools,
    stopWhen: stepCountIs(prepared.maxSteps),
    timeout: { totalMs: 280_000, stepMs: 120_000, toolMs: 60_000 },
    onStepFinish: (step) => {
      for (const call of step.toolCalls) toolCalls.push({ tool: call.toolName, input: call.input });
      for (const toolResult of step.toolResults) {
        const draft = proposedDraft(toolResult.toolName, toolResult.output);
        if (draft) drafts.push(draft);
      }
    },
  });
  const usage = usageFrom(result.totalUsage);
  const cost = await recordAiRun(env, { kind: "agent", keyId: principal.keyId, model: prepared.modelName,
    prompt: request.prompt, identity: request.identity ?? null, toolCalls: toolCalls.length,
    usage, durationMs: Date.now() - startedAt });
  const daily = await dailyNeurons(env);
  console.log(JSON.stringify({ event: "agent-run", stream: false, model: prepared.modelName,
    toolCalls: toolCalls.length, usage, costUsd: cost.costUsd }));
  return { text: result.text, model: prepared.modelName, toolCalls, drafts, usage,
    neurons: cost.neurons, costUsd: cost.costUsd, dailyNeurons: daily };
}

export interface AgentTurnRecord {
  text: string;
  activity: ActivityItem[];
  sources: SourceItem[];
  error: string | null;
}

export interface AgentStreamOptions {
  // Earlier turns of a saved chat, oldest first; the request's prompt follows them.
  history?: ModelMessage[];
  chat?: AgentContext["chat"];
  // Runs with what the turn produced before the stream closes; returns more events to send.
  onComplete?: (turn: AgentTurnRecord) => Promise<Array<Record<string, unknown>>>;
  // Keeps the run (and its record) going when the client disconnects mid-answer.
  waitUntil?: (promise: Promise<unknown>) => void;
  // Sent before anything else, e.g. the chat ids.
  firstEvent?: Record<string, unknown>;
}

// NDJSON event stream: reasoning and tool activity as they happen, text
// deltas for the final answer, proposed emails and the mail the agent looked
// at, and a closing usage record.
export async function runMailAgentStream(env: Env, principal: AuthPrincipal, request: AgentRunRequest,
  modelOverride?: LanguageModel, options: AgentStreamOptions = {}): Promise<Response> {
  const prepared = await prepareAgentRun(env, principal, request, modelOverride, options.chat);
  const result = streamText({
    model: prepared.model,
    system: prepared.system,
    ...(options.history ? { messages: [...options.history, { role: "user" as const, content: request.prompt }] } : { prompt: request.prompt }),
    tools: prepared.tools,
    stopWhen: stepCountIs(prepared.maxSteps),
    timeout: { totalMs: 280_000, stepMs: 120_000, toolMs: 60_000 },
  });
  const encoder = new TextEncoder();
  const startedAt = Date.now();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let clientGone = false;
  let lastEventAt = Date.now();
  const emit = (event: Record<string, unknown>): void => {
    lastEventAt = Date.now();
    if (clientGone) return;
    writer.write(encoder.encode(`${JSON.stringify(event)}\n`)).catch(() => { clientGone = true; });
  };
  const turn: AgentTurnRecord = { text: "", activity: [], sources: [], error: null };
  const pump = async (): Promise<void> => {
    // While the model is prefilling a large context the provider produces
    // nothing; heartbeats let the client show progress instead of silence.
    const heartbeat = setInterval(() => {
      if (Date.now() - lastEventAt < 4_000) return;
      emit({ type: "heartbeat", elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000) });
    }, 2_000);
    let toolCalls = 0;
    if (options.firstEvent) emit(options.firstEvent);
    try {
      for await (const part of result.fullStream) {
        switch (part.type) {
          case "reasoning-delta":
            emit({ type: "reasoning", text: part.text });
            break;
          case "text-delta":
            turn.text += part.text;
            emit({ type: "text", text: part.text });
            break;
          case "tool-call": {
            toolCalls += 1;
            const label = activityLabel(part.toolName, part.input);
            turn.activity.push({ tool: part.toolName, label });
            emit({ type: "tool-call", tool: part.toolName, input: part.input, label });
            break;
          }
          case "tool-result": {
            emit({ type: "tool-result", tool: part.toolName });
            const draft = proposedDraft(part.toolName, part.output);
            if (draft) emit({ type: "draft", draft });
            const sources = sourcesFrom(part.toolName, part.output).filter((source) => mergeSource(turn.sources, source));
            if (sources.length) emit({ type: "sources", messages: sources });
            break;
          }
          case "tool-error":
            emit({ type: "tool-error", tool: part.toolName, error: String(part.error).slice(0, 300) });
            break;
          case "finish": {
            const usage = usageFrom(part.totalUsage);
            const cost = await recordAiRun(env, { kind: "agent", keyId: principal.keyId,
              model: prepared.modelName, prompt: request.prompt, identity: request.identity ?? null,
              toolCalls, usage, durationMs: Date.now() - startedAt });
            const daily = await dailyNeurons(env);
            console.log(JSON.stringify({ event: "agent-run", stream: true, model: prepared.modelName,
              toolCalls, usage, costUsd: cost.costUsd }));
            emit({ type: "finish", model: prepared.modelName, toolCalls, usage,
              neurons: Math.round(cost.neurons * 10) / 10, costUsd: cost.costUsd, dailyNeurons: daily });
            break;
          }
          case "error":
            turn.error = String(part.error).slice(0, 500);
            emit({ type: "error", message: turn.error });
            break;
          default:
            break;
        }
      }
    } catch (error) {
      turn.error = String(error).slice(0, 500);
      emit({ type: "error", message: turn.error });
    } finally {
      clearInterval(heartbeat);
      if (options.onComplete) {
        try {
          for (const event of await options.onComplete(turn)) emit(event);
        } catch (error) {
          console.error(JSON.stringify({ event: "agent-turn-record-failed", error: String(error).slice(0, 300) }));
        }
      }
      await writer.close().catch(() => undefined);
    }
  };
  const running = pump();
  options.waitUntil?.(running);
  return new Response(readable, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" },
  });
}

const quoted = (value: unknown) => typeof value === "string" && value ? ` “${value.slice(0, 60)}”` : "";

/** What a tool call looks like to the person watching the agent work. */
export function activityLabel(tool: string, input: unknown): string {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  switch (tool) {
    case "semantic_search": return `Searched mail for${quoted(args.query)}`;
    case "graph_lookup": return args.entity ? `Looked up${quoted(args.entity)}` : "Looked up related mail";
    case "list_messages": {
      const folder = typeof args.folder === "string" ? args.folder : "inbox";
      if (args.query) return `Searched ${folder} for${quoted(args.query)}`;
      if (args.from) return `Looked for mail from${quoted(args.from)}`;
      if (args.needsReply) return "Listed mail waiting for a reply";
      return `Listed ${args.unreadOnly ? "unread mail in " : ""}${folder}`;
    }
    case "read_message": return "Read a message";
    case "update_message": return "Updated a message";
    case "list_contacts": return args.query ? `Checked contacts for${quoted(args.query)}` : "Checked contacts";
    case "mailbox_summary": return "Counted mail";
    case "style_examples": return typeof args.address === "string" ? `Read your earlier mails to ${args.address}` : "Read your earlier mails";
    case "list_drafts": return "Checked drafts";
    case "propose_email": return args.revisesDraftId ? "Revised the email" : "Wrote an email";
    case "read_thread": return "Read the conversation";
    case "read_attachment": return "Read an attachment";
    case "save_contact": return typeof args.address === "string" ? `Saved ${args.address} to contacts` : "Saved a contact";
    case "list_identities": return "Checked your mailboxes";
    case "autopilot_log": return "Checked what the autopilot did";
    case "undo_autopilot_action": return "Undid an autopilot action";
    default: return tool.replaceAll("_", " ");
  }
}

function proposedDraft(tool: string, output: unknown): ProposedEmail | null {
  if (tool !== "propose_email" || typeof output !== "object" || output === null || !("draft" in output)) return null;
  return (output as { draft: ProposedEmail }).draft;
}

/** Mail a tool result refers to; read messages count as read, search hits as seen. */
export function sourcesFrom(tool: string, output: unknown): SourceItem[] {
  if (typeof output !== "object" || output === null) return [];
  const record = output as Record<string, unknown>;
  const list = tool === "read_message" ? [record]
    : tool === "list_messages" || tool === "read_thread" ? record.messages
      : tool === "semantic_search" ? record.results : null;
  if (!Array.isArray(list)) return [];
  return list.flatMap((item: unknown) => {
    if (typeof item !== "object" || item === null) return [];
    const entry = item as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.subject !== "string") return [];
    return [{ id: entry.id, subject: entry.subject, from: typeof entry.from === "string" ? entry.from : "",
      receivedAt: typeof entry.receivedAt === "string" ? entry.receivedAt : "",
      identity: typeof entry.identity === "string" ? entry.identity : null, read: tool === "read_message" || tool === "read_thread" }];
  });
}

/** Adds a source once; a message that was read upgrades an earlier search hit. Returns whether it is news. */
function mergeSource(sources: SourceItem[], source: SourceItem): boolean {
  const existing = sources.find((item) => item.id === source.id);
  if (!existing) {
    if (sources.length >= 24) return false;
    sources.push(source);
    return true;
  }
  if (source.read && !existing.read) {
    existing.read = true;
    return true;
  }
  return false;
}

function systemPrompt(env: Env, identities: string[], request: AgentRunRequest): string {
  const service = appName(env);
  const owner = ownerName(env);
  return [
    `You are the ${service} agent: you help ${owner}, the owner of this mailbox, with their mail through tools.`,
    `Accessible identities: ${identities.join(", ")}.`,
    request.identity ? `The user scoped this session to ${request.identity}; use it unless told otherwise.` : "",
    `Today is ${new Date().toISOString().slice(0, 10)}.`,
    "Tool strategy: for topical, fuzzy, or cross-mailbox questions start with semantic_search (meaning-based, indexes every message); use graph_lookup to find the people, organizations, amounts, commitments, and related threads around an entity or message; use list_messages only to enumerate a folder; use read_message once you have the right id. Avoid repeated keyword guessing.",
    "Be decisive: once the retrieved context answers the request, respond immediately — do not re-verify with additional searches or second-guess a clear result.",
    `Work autonomously: you have every mailbox, every message and thread, attachments, contacts, the autopilot's log and the knowledge graph. Find things out yourself instead of asking ${owner}, and organize mail (archive, mark read, star, spam), save contacts and undo autopilot mistakes on your own when it serves their request; say briefly what you changed. Only sending is theirs: you prepare it with propose_email.`,
    "list_messages carries the autopilot's triage: filter with needsReply=true for mail a person waits on, and by category, sender or date. Use read_thread for whole conversations and read_attachment for documents.",
    "Ground every statement about mail in tool results; never invent message content.",
    "Keep answers short and factual, in Markdown (short paragraphs, lists, bold for names and dates). Answer in the language the user writes in.",
    `You cannot send email, and you never claim that an email was sent. Every email you write — a reply, a new mail, or a revision — goes through propose_email: ${owner} sees it as an editable card with a Send button and sends it themselves.`,
    `Before writing to someone, call style_examples with their address to see how ${owner} wrote to them before, then write in their voice. For a reply, read the original first and pass its id as replyToMessageId. Saved reply drafts (some written automatically) are available through list_drafts.`,
    `After propose_email, do not repeat the email in your answer: one short sentence about it is enough. When ${owner} asks for changes to an email, call propose_email again with revisesDraftId set to that email's id.`,
    styleGuide(env),
  ].filter(Boolean).join("\n");
}

export function buildAgentTools(context: AgentContext): ToolSet {
  return {
    semantic_search: tool({
      description: "Meaning-based search across all mail (multilingual). Best first step for topical or fuzzy questions like 'expense reimbursement' or 'apple receipt'. Returns ranked messages with one-line gists.",
      inputSchema: z.object({
        query: z.string().min(2).max(300),
        identity: z.string().email().optional(),
        topK: z.number().int().min(1).max(15).default(6),
      }),
      execute: async (input) => {
        if (input.identity && !identityAllowed(context, input.identity)) {
          return { error: `Identity ${input.identity} is outside this credential's access policy` };
        }
        return { results: await semanticSearch(context.env, context.principal.allowedIdentities,
          { query: input.query, identity: input.identity ?? context.requestedIdentity, topK: input.topK }) };
      },
    }),
    graph_lookup: tool({
      description: "Knowledge-graph lookup. Given an entity name (person, organization, project, amount) or a message id, returns its entities, relations (commitments, amounts, who-asked-whom), and related messages with gists.",
      inputSchema: z.object({
        entity: z.string().min(1).max(120).optional().describe("Entity name or fragment, e.g. 'Acme Corp'"),
        messageId: z.string().min(1).max(64).optional(),
      }),
      execute: async (input) => graphLookup(context.env, context.principal.allowedIdentities, input),
    }),
    list_messages: tool({
      description: "List or search messages in a folder, newest first, with the autopilot's triage (category, needsReply, urgency 0-3). Filter by free text (subject, sender, preview), sender, date range, category or whether a person waits for a reply.",
      inputSchema: z.object({
        identity: z.string().email().optional().describe("Mailbox identity address; omit to search every accessible identity"),
        folder: z.enum(FOLDERS).default("inbox"),
        query: z.string().max(50).optional(),
        from: z.string().max(100).optional().describe("Sender name or address fragment"),
        since: z.string().max(30).optional().describe("ISO date or time: only mail received at or after it"),
        before: z.string().max(30).optional().describe("ISO date or time: only mail received before it"),
        category: z.enum(["personal", "school", "agent", "notification", "code", "receipt", "newsletter", "spam"]).optional(),
        needsReply: z.boolean().optional().describe("true: only mail where a person waits on the owner"),
        unreadOnly: z.boolean().default(false),
        limit: z.number().int().min(1).max(50).default(10),
      }),
      execute: async (input) => listMessages(context, input),
    }),
    read_thread: tool({
      description: "Read a whole conversation: every message in the thread of a message id, oldest first, with bodies.",
      inputSchema: z.object({ messageId: z.string().min(1).max(64) }),
      execute: async (input) => readThread(context, input.messageId),
    }),
    read_attachment: tool({
      description: "Read an attachment's content as text: plain text, calendar files and HTML directly; PDFs, Office documents, spreadsheets and images are converted. Use the attachment id from read_message.",
      inputSchema: z.object({ attachmentId: z.string().min(1).max(64) }),
      execute: async (input) => readAttachment(context, input.attachmentId),
    }),
    read_message: tool({
      description: "Read one message: headers, full text body, and attachment names. Use the id from list_messages.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      execute: async (input) => readMessage(context, input.id),
    }),
    update_message: tool({
      description: "Organize one message: mark read/unread, star/unstar, move it to another folder, or mark it as spam / not spam.",
      inputSchema: z.object({
        id: z.string().min(1).max(64),
        unread: z.boolean().optional(),
        starred: z.boolean().optional(),
        folder: z.enum(MUTABLE_FOLDERS).optional(),
        spam: z.boolean().optional(),
      }),
      execute: async (input) => updateMessage(context, input),
    }),
    propose_email: tool({
      description: "Show the mailbox owner an email as an editable draft card with a Send button. Use it for every email you write: replies, new mails and revisions. You cannot send; the owner reviews, edits and sends it themselves.",
      inputSchema: z.object({
        from: z.string().email().describe("One of the accessible identities; a reply always goes out from the identity that received the original"),
        to: z.array(z.string().email()).min(1).max(20),
        cc: z.array(z.string().email()).max(20).default([]),
        subject: z.string().max(998),
        body: z.string().min(1).max(20_000).describe("The full text of the email, greeting to sign-off, in the owner's voice"),
        replyToMessageId: z.string().max(64).optional().describe("Message id being replied to, for correct threading"),
        revisesDraftId: z.string().max(64).optional().describe("The id of the proposed email this one replaces, when revising"),
      }),
      execute: async (input) => proposeEmail(context, input),
    }),
    style_examples: tool({
      description: "The owner's earlier sent mails to a person (or, failing that, to the same organisation), to write in the voice they use with them.",
      inputSchema: z.object({ address: z.string().email() }),
      execute: async (input) => styleExamples(context, input.address),
    }),
    list_drafts: tool({
      description: "Saved email drafts, newest first, including reply drafts the autopilot wrote for mail waiting on the owner.",
      inputSchema: z.object({
        identity: z.string().email().optional(),
        limit: z.number().int().min(1).max(20).default(8),
      }),
      execute: async (input) => listDrafts(context, input),
    }),
    list_contacts: tool({
      description: "List known contacts, optionally filtered by a name or address fragment.",
      inputSchema: z.object({
        identity: z.string().email().optional(),
        query: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(50).default(15),
      }),
      execute: async (input) => listContacts(context, input),
    }),
    save_contact: tool({
      description: "Add a contact to a mailbox's address book, or rename one. Contacts are trusted: their mail is never marked as spam.",
      inputSchema: z.object({
        identity: z.string().email().describe("The mailbox whose address book it is"),
        address: z.string().email(),
        name: z.string().max(200).default(""),
      }),
      execute: async (input) => saveContact(context, input),
    }),
    list_identities: tool({
      description: "The owner's mailboxes (addresses they receive and send as), with display names and whether each is a routed domain or an external IMAP/SMTP account.",
      inputSchema: z.object({}),
      execute: async () => listIdentities(context),
    }),
    autopilot_log: tool({
      description: "What the autopilot did on its own (spam flagged, mail archived, alerts collapsed, reply drafts written), newest first, plus its rules and settings.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).default(20) }),
      execute: async (input) => autopilotLog(context, input.limit),
    }),
    undo_autopilot_action: tool({
      description: "Undo one autopilot action by its id from autopilot_log: puts filed mail back, clears a spam flag, removes a draft.",
      inputSchema: z.object({ id: z.string().min(1).max(64) }),
      execute: async (input) => undoAutopilotAction(context, input.id),
    }),
    mailbox_summary: tool({
      description: "Folder and unread counts for the accessible mailboxes.",
      inputSchema: z.object({ identity: z.string().email().optional() }),
      execute: async (input) => mailboxSummary(context, input.identity),
    }),
  };
}

async function accessibleIdentities(context: AgentContext): Promise<string[]> {
  const allowed = context.principal.allowedIdentities;
  const rows = await context.env.DB.prepare("SELECT address FROM identities WHERE enabled = 1 ORDER BY address")
    .all<{ address: string }>();
  let identities = rows.results.map((row) => row.address);
  if (allowed !== null) identities = identities.filter((address) => allowed.includes(address));
  if (context.requestedIdentity) identities = identities.filter((address) => address === context.requestedIdentity);
  return identities;
}

function identityAllowed(context: AgentContext, identity: string): boolean {
  const allowed = context.principal.allowedIdentities;
  return allowed === null || allowed.includes(identity.toLowerCase());
}

function accessClause(context: AgentContext, column: string, identity?: string): { sql: string; bindings: string[] } | { error: string } {
  const allowed = context.principal.allowedIdentities;
  const requested = identity ?? context.requestedIdentity;
  if (requested) {
    if (allowed !== null && !allowed.includes(requested.toLowerCase())) {
      return { error: `Identity ${requested} is outside this credential's access policy` };
    }
    return { sql: `${column} = ?`, bindings: [requested.toLowerCase()] };
  }
  if (allowed === null) return { sql: "1 = 1", bindings: [] };
  if (allowed.length === 0) return { sql: "0 = 1", bindings: [] };
  return { sql: `${column} IN (${allowed.map(() => "?").join(",")})`, bindings: allowed };
}

async function listMessages(context: AgentContext, input: {
  identity?: string; folder: (typeof FOLDERS)[number]; query?: string; from?: string; since?: string; before?: string;
  category?: string; needsReply?: boolean; unreadOnly: boolean; limit: number;
}): Promise<unknown> {
  const access = accessClause(context, "m.identity_address", input.identity);
  if ("error" in access) return { error: access.error };
  const conditions = ["m.status = 'ready'", access.sql];
  const bindings: unknown[] = [...access.bindings];
  if (input.folder === "starred") conditions.push("m.starred = 1", "m.folder != 'trash'");
  else if (input.folder !== "all") { conditions.push("m.folder = ?"); bindings.push(input.folder); }
  if (input.unreadOnly) conditions.push("m.unread = 1");
  const like = (value: string) => `%${value.replaceAll(/[\\%_]/g, "\\$&")}%`;
  if (input.query) {
    conditions.push("(m.subject LIKE ? ESCAPE '\\' OR m.sender_name LIKE ? ESCAPE '\\' OR m.sender_address LIKE ? ESCAPE '\\' OR m.preview LIKE ? ESCAPE '\\')");
    bindings.push(like(input.query), like(input.query), like(input.query), like(input.query));
  }
  if (input.from) {
    conditions.push("(m.sender_name LIKE ? ESCAPE '\\' OR m.sender_address LIKE ? ESCAPE '\\')");
    bindings.push(like(input.from), like(input.from));
  }
  const date = (value: string | undefined) => {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
  };
  const since = date(input.since);
  const before = date(input.before);
  if (since) { conditions.push("m.received_at >= ?"); bindings.push(since); }
  if (before) { conditions.push("m.received_at < ?"); bindings.push(before); }
  if (input.category) { conditions.push("m.triage_category = ?"); bindings.push(input.category); }
  if (input.needsReply !== undefined) conditions.push(input.needsReply ? "m.triage_needs_reply >= 0.5" : "COALESCE(m.triage_needs_reply, 0) < 0.5");
  const rows = await context.env.DB.prepare(`SELECT m.id, m.identity_address, m.direction, m.folder,
    m.external_folder, m.subject, m.sender_name, m.sender_address, m.preview, m.received_at,
    m.unread, m.starred, m.spam, m.has_attachments, m.triage_category, m.triage_needs_reply, m.triage_urgency, g.gist
    FROM messages m LEFT JOIN message_gists g ON g.message_id = m.id
    WHERE ${conditions.join(" AND ")} ORDER BY m.received_at DESC, m.id DESC LIMIT ?`)
    .bind(...bindings, input.limit).all<MessageRow & { gist: string | null }>();
  return {
    messages: rows.results.map((row) => ({
      id: row.id,
      identity: row.identity_address,
      folder: row.folder,
      originFolder: row.external_folder ?? undefined,
      direction: row.direction,
      from: row.sender_name ? `${row.sender_name} <${row.sender_address}>` : row.sender_address,
      subject: row.subject.slice(0, 150),
      gist: row.gist ?? row.preview.slice(0, 100),
      receivedAt: row.received_at,
      unread: Boolean(row.unread),
      starred: Boolean(row.starred),
      spam: Boolean(row.spam) || undefined,
      hasAttachments: Boolean(row.has_attachments),
      category: row.triage_category ?? undefined,
      needsReply: row.triage_needs_reply === null || row.triage_needs_reply === undefined ? undefined : row.triage_needs_reply >= 0.5,
      urgency: row.triage_urgency ?? undefined,
    })),
  };
}

async function readMessage(context: AgentContext, id: string): Promise<unknown> {
  const access = accessClause(context, "identity_address");
  if ("error" in access) return { error: access.error };
  const message = await context.env.DB.prepare(`SELECT * FROM messages WHERE id = ? AND status = 'ready' AND ${access.sql}`)
    .bind(id, ...access.bindings).first<MessageRow>();
  if (!message) return { error: "Message not found" };
  const attachments = await context.env.DB.prepare(
    "SELECT id, filename, content_type, size FROM attachments WHERE message_id = ? ORDER BY rowid").bind(id)
    .all<{ id: string; filename: string; content_type: string; size: number }>();
  let body: string | null = null;
  if (message.text_key) {
    const object = await context.env.MAIL.get(message.text_key);
    body = object ? await object.text() : null;
  }
  if (body === null && message.html_key) {
    const object = await context.env.MAIL.get(message.html_key);
    const html = object ? await object.text() : null;
    body = html ? html.replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim() : null;
  }
  const truncated = body !== null && body.length > MAX_BODY_CHARS;
  return {
    id: message.id,
    identity: message.identity_address,
    folder: message.folder,
    originFolder: message.external_folder ?? undefined,
    direction: message.direction,
    from: message.sender_name ? `${message.sender_name} <${message.sender_address}>` : message.sender_address,
    to: addressSummary(message.recipients_json),
    cc: addressSummary(message.cc_json),
    subject: message.subject,
    receivedAt: message.received_at,
    unread: Boolean(message.unread),
    starred: Boolean(message.starred),
    body: body === null ? "[no text body stored]" : truncated ? `${body.slice(0, MAX_BODY_CHARS)}\n[truncated]` : body,
    threadId: message.thread_id,
    attachments: attachments.results.map((item) => ({ id: item.id, filename: item.filename, contentType: item.content_type, size: item.size })),
  };
}

async function updateMessage(context: AgentContext, input: { id: string; unread?: boolean; starred?: boolean; folder?: string; spam?: boolean }): Promise<unknown> {
  if (!hasScope(context.principal.scopes, "mail:write")) return { error: "This credential lacks the mail:write scope" };
  const assignments: string[] = [];
  const bindings: unknown[] = [];
  if (input.unread !== undefined) { assignments.push("unread = ?"); bindings.push(Number(input.unread)); }
  if (input.starred !== undefined) { assignments.push("starred = ?"); bindings.push(Number(input.starred)); }
  if (input.folder !== undefined) { assignments.push("folder = ?"); bindings.push(input.folder); }
  if (input.spam !== undefined) { assignments.push("spam = ?"); bindings.push(Number(input.spam)); }
  if (assignments.length === 0) return { error: "No update supplied" };
  const access = accessClause(context, "identity_address");
  if ("error" in access) return { error: access.error };
  const result = await context.env.DB.prepare(`UPDATE messages SET ${assignments.join(", ")}, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND ${access.sql}`).bind(...bindings, input.id, ...access.bindings).run();
  return result.meta.changes ? { updated: true } : { error: "Message not found" };
}

async function proposeEmail(context: AgentContext, input: {
  from: string; to: string[]; cc: string[]; subject: string; body: string; replyToMessageId?: string; revisesDraftId?: string;
}): Promise<unknown> {
  let from = input.from.toLowerCase();
  if (input.replyToMessageId) {
    const access = accessClause(context, "identity_address");
    if ("error" in access) return { error: access.error };
    const original = await context.env.DB.prepare(`SELECT identity_address FROM messages WHERE id = ? AND status = 'ready' AND ${access.sql}`)
      .bind(input.replyToMessageId, ...access.bindings).first<{ identity_address: string | null }>();
    if (!original) return { error: "The message to reply to was not found" };
    // A reply goes out from the mailbox that received the original.
    if (original.identity_address) from = original.identity_address;
  }
  if (!identityAllowed(context, from)) return { error: `Identity ${from} is outside this credential's access policy` };
  const identity = await context.env.DB.prepare("SELECT address FROM identities WHERE address = ? AND enabled = 1").bind(from).first();
  if (!identity) return { error: `${from} is not an enabled mailbox` };
  const draft: ProposedEmail = {
    id: crypto.randomUUID(), from,
    to: input.to.map((address) => address.toLowerCase()), cc: input.cc.map((address) => address.toLowerCase()),
    subject: input.subject, body: signedForIdentity(context.env, from, input.body.trim()),
    replyToMessageId: input.replyToMessageId ?? null, revisesDraftId: input.revisesDraftId ?? null, status: "draft",
  };
  if (context.chat) {
    const statements = [context.env.DB.prepare(`INSERT INTO agent_chat_drafts
      (id, chat_id, message_id, identity_address, to_json, cc_json, subject, body, reply_to_message_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(draft.id, context.chat.chatId, context.chat.messageId, draft.from,
      JSON.stringify(draft.to), JSON.stringify(draft.cc), draft.subject, draft.body, draft.replyToMessageId)];
    if (input.revisesDraftId) {
      statements.push(context.env.DB.prepare(`UPDATE agent_chat_drafts SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND chat_id = ? AND status = 'draft'`).bind(input.revisesDraftId, context.chat.chatId));
    }
    await context.env.DB.batch(statements);
  }
  return { draftId: draft.id, draft, shown: "The owner now sees this email as an editable card with a Send button. Do not repeat it in your answer." };
}

async function styleExamples(context: AgentContext, address: string): Promise<unknown> {
  const examples = await earlierMails(context.env, address.toLowerCase(), new Date().toISOString());
  if (!examples.length) return { examples: [], note: "No earlier sent mail to this person or organisation was found; follow the style guide." };
  return { examples: examples.map((example) => ({ to: addressSummary(example.recipients_json), date: example.received_at.slice(0, 10),
    subject: example.subject, text: example.text.slice(0, 1_200) })) };
}

async function listDrafts(context: AgentContext, input: { identity?: string; limit: number }): Promise<unknown> {
  const access = accessClause(context, "identity_address", input.identity);
  if ("error" in access) return { error: access.error };
  const rows = await context.env.DB.prepare(`SELECT id, identity_address, reply_to_message_id, recipients_json, subject, text_body, updated_at
    FROM drafts WHERE ${access.sql} ORDER BY updated_at DESC LIMIT ?`).bind(...access.bindings, input.limit)
    .all<{ id: string; identity_address: string; reply_to_message_id: string | null; recipients_json: string; subject: string;
      text_body: string; updated_at: string }>();
  return { drafts: rows.results.map((row) => ({ id: row.id, from: row.identity_address, to: addressSummary(row.recipients_json),
    subject: row.subject, replyToMessageId: row.reply_to_message_id, updatedAt: row.updated_at, body: row.text_body.slice(0, 1_500) })) };
}

const THREAD_BODY_CHARS = 3_000;
const THREAD_TOTAL_CHARS = 24_000;
const ATTACHMENT_CHARS = 15_000;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

async function bodyText(env: Env, message: Pick<MessageRow, "text_key" | "html_key" | "preview">): Promise<string> {
  if (message.text_key) {
    const object = await env.MAIL.get(message.text_key);
    if (object) return object.text();
  }
  if (message.html_key) {
    const object = await env.MAIL.get(message.html_key);
    if (object) return (await object.text()).replaceAll(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replaceAll(/<[^>]+>/g, " ").replaceAll(/\s+/g, " ").trim();
  }
  return message.preview;
}

async function readThread(context: AgentContext, messageId: string): Promise<unknown> {
  const access = accessClause(context, "identity_address");
  if ("error" in access) return { error: access.error };
  const anchorRow = await context.env.DB.prepare(`SELECT thread_id FROM messages WHERE id = ? AND status = 'ready' AND ${access.sql}`)
    .bind(messageId, ...access.bindings).first<{ thread_id: string }>();
  if (!anchorRow) return { error: "Message not found" };
  const rows = await context.env.DB.prepare(`SELECT * FROM messages WHERE thread_id = ? AND status = 'ready' AND ${access.sql}
    ORDER BY received_at, id LIMIT 40`).bind(anchorRow.thread_id, ...access.bindings).all<MessageRow>();
  let budget = THREAD_TOTAL_CHARS;
  const messages = [];
  for (const row of rows.results) {
    const text = budget > 0 ? (await bodyText(context.env, row)).slice(0, Math.min(THREAD_BODY_CHARS, budget)) : "[omitted: thread too long]";
    budget -= text.length;
    messages.push({ id: row.id, direction: row.direction, folder: row.folder,
      from: row.sender_name ? `${row.sender_name} <${row.sender_address}>` : row.sender_address,
      to: addressSummary(row.recipients_json), subject: row.subject, receivedAt: row.received_at, body: text });
  }
  return { threadId: anchorRow.thread_id, messages };
}

const TEXT_TYPES = /^(text\/|application\/(json|xml|ics)|application\/x-(sh|yaml))/i;

async function readAttachment(context: AgentContext, attachmentId: string): Promise<unknown> {
  const access = accessClause(context, "m.identity_address");
  if ("error" in access) return { error: access.error };
  const row = await context.env.DB.prepare(`SELECT a.filename, a.content_type, a.object_key, a.size FROM attachments a
    JOIN messages m ON m.id = a.message_id WHERE a.id = ? AND ${access.sql}`).bind(attachmentId, ...access.bindings)
    .first<{ filename: string; content_type: string; object_key: string; size: number }>();
  if (!row) return { error: "Attachment not found" };
  if (row.size > MAX_ATTACHMENT_BYTES) return { error: `The attachment is ${Math.round(row.size / 1_048_576)} MB; only files up to 10 MB are read` };
  const object = await context.env.MAIL.get(row.object_key);
  if (!object) return { error: "The attachment's content is missing from storage" };
  const bytes = await object.arrayBuffer();
  let text: string;
  if (TEXT_TYPES.test(row.content_type) || /\.(txt|csv|ics|md|json|xml|log|eml)$/i.test(row.filename)) {
    text = new TextDecoder().decode(bytes);
  } else {
    try {
      const converted = await context.env.AI.toMarkdown({ name: row.filename, blob: new Blob([bytes], { type: row.content_type }) });
      if (converted.format === "error") return { error: `Could not read ${row.filename}: ${converted.error}` };
      text = converted.data;
    } catch (error) {
      return { error: `Could not read ${row.filename}: ${String(error).slice(0, 200)}` };
    }
  }
  const truncated = text.length > ATTACHMENT_CHARS;
  return { filename: row.filename, contentType: row.content_type, text: truncated ? `${text.slice(0, ATTACHMENT_CHARS)}\n[truncated]` : text };
}

async function saveContact(context: AgentContext, input: { identity: string; address: string; name: string }): Promise<unknown> {
  if (!hasScope(context.principal.scopes, "mail:write")) return { error: "This credential lacks the mail:write scope" };
  const identity = input.identity.toLowerCase();
  if (!identityAllowed(context, identity)) return { error: `Identity ${identity} is outside this credential's access policy` };
  const enabled = await context.env.DB.prepare("SELECT address FROM identities WHERE address = ? AND enabled = 1").bind(identity).first();
  if (!enabled) return { error: `${identity} is not an enabled mailbox` };
  await context.env.DB.prepare(`INSERT INTO contacts (identity_address, address, display_name, source) VALUES (?, ?, ?, 'manual')
    ON CONFLICT(identity_address, address) DO UPDATE SET
      display_name = CASE WHEN excluded.display_name = '' THEN contacts.display_name ELSE excluded.display_name END,
      updated_at = CURRENT_TIMESTAMP`).bind(identity, input.address.toLowerCase(), input.name.trim()).run();
  return { saved: true, identity, address: input.address.toLowerCase(), name: input.name.trim() || undefined };
}

async function listIdentities(context: AgentContext): Promise<unknown> {
  const access = accessClause(context, "address");
  if ("error" in access) return { error: access.error };
  const rows = await context.env.DB.prepare(`SELECT address, display_name, kind FROM identities WHERE enabled = 1 AND ${access.sql}
    ORDER BY address`).bind(...access.bindings).all<{ address: string; display_name: string; kind: string }>();
  return { identities: rows.results.map((row) => ({ address: row.address, name: row.display_name || undefined,
    kind: row.kind === "external" ? "external account (synced over IMAP, sends through its own server)" : "own domain" })) };
}

async function autopilotLog(context: AgentContext, limit: number): Promise<unknown> {
  const access = accessClause(context, "m.identity_address");
  if ("error" in access) return { error: access.error };
  const [settings, rules, actions] = await Promise.all([
    readAutopilotSettings(context.env), listRules(context.env),
    context.env.DB.prepare(`SELECT a.id, a.action, a.detail, a.created_at, a.undone_at, m.id AS message_id, m.subject, m.sender_address
      FROM autopilot_actions a JOIN messages m ON m.id = a.message_id WHERE ${access.sql}
      ORDER BY a.created_at DESC LIMIT ?`).bind(...access.bindings, limit)
      .all<{ id: string; action: string; detail: string; created_at: string; undone_at: string | null; message_id: string; subject: string; sender_address: string }>(),
  ]);
  return {
    settings,
    rules: rules.map((rule) => ({ id: rule.id, category: rule.category, action: rule.action, maxUrgency: rule.max_urgency,
      minConfidence: rule.min_confidence, sender: rule.sender_match ?? undefined, enabled: Boolean(rule.enabled) })),
    actions: actions.results.map((row) => ({ id: row.id, action: row.action, detail: row.detail, at: row.created_at,
      undone: Boolean(row.undone_at), messageId: row.message_id, subject: row.subject, from: row.sender_address })),
  };
}

async function undoAutopilotAction(context: AgentContext, id: string): Promise<unknown> {
  if (!hasScope(context.principal.scopes, "mail:write")) return { error: "This credential lacks the mail:write scope" };
  const access = accessClause(context, "m.identity_address");
  if ("error" in access) return { error: access.error };
  const action = await context.env.DB.prepare(`SELECT a.* FROM autopilot_actions a JOIN messages m ON m.id = a.message_id
    WHERE a.id = ? AND ${access.sql}`).bind(id, ...access.bindings).first<ActionRow>();
  if (!action) return { error: "Autopilot action not found" };
  return undoAction(context.env, action);
}

async function listContacts(context: AgentContext, input: { identity?: string; query?: string; limit: number }): Promise<unknown> {
  const access = accessClause(context, "identity_address", input.identity);
  if ("error" in access) return { error: access.error };
  const conditions = [access.sql];
  const bindings: unknown[] = [...access.bindings];
  if (input.query) {
    const escaped = `%${input.query.toLowerCase().replaceAll(/[\\%_]/g, "\\$&")}%`;
    conditions.push("(lower(address) LIKE ? ESCAPE '\\' OR lower(display_name) LIKE ? ESCAPE '\\')");
    bindings.push(escaped, escaped);
  }
  const rows = await context.env.DB.prepare(`SELECT identity_address, address, display_name, send_count, last_sent_at
    FROM contacts WHERE ${conditions.join(" AND ")}
    ORDER BY send_count DESC, COALESCE(last_sent_at, updated_at) DESC, address ASC LIMIT ?`)
    .bind(...bindings, input.limit).all<ContactRow>();
  return {
    contacts: rows.results.map((row) => ({
      identity: row.identity_address,
      address: row.address,
      name: row.display_name || undefined,
      sendCount: row.send_count,
      lastSentAt: row.last_sent_at,
    })),
  };
}

async function mailboxSummary(context: AgentContext, identity?: string): Promise<unknown> {
  const access = accessClause(context, "identity_address", identity);
  if ("error" in access) return { error: access.error };
  const rows = await context.env.DB.prepare(`SELECT identity_address, unread, inbox, sent, starred, archive, trash, drafts
    FROM mailbox_counts WHERE ${access.sql} ORDER BY identity_address`).bind(...access.bindings)
    .all<{ identity_address: string; unread: number; inbox: number; sent: number; starred: number; archive: number; trash: number; drafts: number }>();
  return { mailboxes: rows.results };
}

function addressSummary(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      if (typeof item === "string") return [item];
      if (typeof item === "object" && item !== null && "address" in item && typeof item.address === "string") return [item.address];
      return [];
    }).slice(0, 20);
  } catch {
    return [];
  }
}
