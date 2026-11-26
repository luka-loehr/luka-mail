// Inbound triage: what kind of mail this is, whether it is spam, whether a
// person is waiting on the owner, and how urgent it is.
//
// Two Clef models answer the same four questions in parallel and their
// probabilities are averaged. Benchmarked on 100 hand-labelled mails from this
// mailbox (2026-10-23): the average flags spam with precision 1.00 and recall
// 0.94 at 0.8 (the llama-3.1-8b filter it replaces: 0.83 / 0.94), puts 92% of
// mail in the right category, and costs about $0.37 per 1,000 messages.
// Either model alone is used when the other fails; when both fail the message
// is delivered untriaged and the cron sweep retries it.

import { ownerProfile } from "./owner-profile";
import type { Env } from "./types";
import { recordAiRun } from "./usage";

export const CATEGORIES = {
  personal: "Written by a real person to the mailbox owner personally: family, friends, collaborators or users writing as individuals.",
  school: "From a school, university or educational institution: teachers, classmates, administration, learning platforms or courses.",
  agent: "A report, result or message written by one of the owner's own AI agents or sent from one of the owner's own addresses.",
  notification: "An automated notice from a service or system the owner uses or runs: alerts, incidents, monitoring, budget and billing alarms, security notices, account and API-key changes, terms updates, subscriptions, invitations, confirmations of forms or applications.",
  code: "A sign-in or verification code, password reset or magic link.",
  receipt: "A receipt, invoice, payment confirmation, order, shipping or purchase confirmation.",
  newsletter: "Marketing, product announcements, events, newsletters or onboarding mail from a company or service.",
  spam: "Unsolicited mail from a stranger who wants something: cold sales or SEO/web/app-development pitches, domain sale offers, unsolicited partnership or 'you were selected' proposals, phishing, scams, or empty meaningless messages from strangers.",
} as const;

export type Category = keyof typeof CATEGORIES;

const QUESTIONS = {
  category: { type: "choice", instructions: "Which kind of mail is this?", criteria: CATEGORIES },
  spam: {
    type: "noul",
    instructions: "Is this spam: unsolicited mail from a stranger who wants something from the mailbox owner?",
    criteria: {
      true: "cold sales or marketing outreach from strangers, SEO/web/app-development offers, domain sale offers, unsolicited partnership or 'you were selected' proposals, phishing that claims an account is limited, scams, or empty meaningless mail from strangers",
      false: "anything the owner would want: mail from people they know, school or work, their own systems and agents, and services they use (alerts, codes, receipts, onboarding, newsletters), even when automated or promotional",
    },
  },
  needs_reply: {
    type: "noul",
    instructions: "Is a real person waiting for the mailbox owner to reply or to do something (answer a question, send something, confirm, show up)?",
    criteria: {
      true: "a person asks them directly for an answer, a document, a confirmation or an action",
      false: "automated mail, newsletters, reports from their own agents, and messages that only inform or thank them",
    },
  },
  urgency: {
    type: "score",
    instructions: "How time-critical is this mail for the mailbox owner?",
    criteria: ["no time pressure", "matters within a week", "matters today or tomorrow", "needs attention right now"],
  },
};

export const TRIAGE_MODELS = ["@cf/cloudflare/clef", "@cf/cloudflare/clef-flash"] as const;
export const SPAM_THRESHOLD = 0.8;
export const NEEDS_REPLY_THRESHOLD = 0.5;
const BODY_CHARS = 2_000;

export interface TriageInput {
  messageId: string | null;
  senderName: string;
  senderAddress: string;
  recipients: string;
  subject: string;
  receivedAt: string;
  text: string;
  identityAddress: string | null;
}

export interface Triage {
  category: Category;
  confidence: number;
  // Averaged probabilities, 0..1.
  spam: number;
  needsReply: number;
  urgency: number;
  model: string;
}

interface ClefAnswers {
  category?: { probabilities?: Record<string, number> };
  spam?: { noul?: number };
  needs_reply?: { noul?: number };
  urgency?: { score?: number };
}

interface ClefResponse {
  answers?: ClefAnswers;
  usage?: { input_tokens?: number };
}

export function buildState(input: TriageInput, profile = ""): string {
  const from = input.senderName ? `${input.senderName} <${input.senderAddress}>` : input.senderAddress;
  const header = profile ? `${profile}\n\n` : "";
  return `${header}From: ${from}\nTo: ${input.recipients}\nSubject: ${input.subject || "(no subject)"}\n`
    + `Date: ${input.receivedAt}\n\n${input.text.slice(0, BODY_CHARS)}`;
}

async function askClef(env: Env, model: string, state: string, identity: string | null): Promise<ClefAnswers | null> {
  const startedAt = Date.now();
  try {
    const response = await env.AI.run(model as Parameters<Ai["run"]>[0],
      { model: model.split("/").at(-1), state, questions: QUESTIONS } as never) as ClefResponse;
    await recordAiRun(env, { kind: "triage", keyId: null, model, prompt: null, identity, toolCalls: null,
      usage: { inputTokens: response?.usage?.input_tokens ?? 0, cachedInputTokens: 0, outputTokens: 0 },
      durationMs: Date.now() - startedAt });
    const answers = response?.answers;
    if (!answers?.category?.probabilities || typeof answers.spam?.noul !== "number") return null;
    return answers;
  } catch (error) {
    console.error(JSON.stringify({ event: "triage-model-failed", model, error: String(error).slice(0, 300) }));
    return null;
  }
}

const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;

/** Averages the models that answered. Exported for tests. */
export function combine(answers: Array<{ model: string; answers: ClefAnswers }>): Triage | null {
  if (answers.length === 0) return null;
  const probabilities = Object.keys(CATEGORIES).map((category) =>
    [category, mean(answers.map(({ answers: a }) => a.category?.probabilities?.[category] ?? 0))] as const);
  const [category, confidence] = probabilities.reduce((best, entry) => entry[1] > best[1] ? entry : best);
  const urgency = mean(answers.map(({ answers: a }) => a.urgency?.score ?? 0));
  return {
    category: category as Category,
    confidence,
    spam: mean(answers.map(({ answers: a }) => a.spam?.noul ?? 0)),
    needsReply: mean(answers.map(({ answers: a }) => a.needs_reply?.noul ?? 0)),
    urgency: Math.max(0, Math.min(3, Math.round(urgency))),
    model: answers.map(({ model }) => model.split("/").at(-1)).join("+"),
  };
}

export async function triageMail(env: Env, input: TriageInput): Promise<Triage | null> {
  const state = buildState(input, ownerProfile(env));
  const results = await Promise.all(TRIAGE_MODELS.map(async (model) => ({ model, answers: await askClef(env, model, state, input.identityAddress) })));
  return combine(results.filter((result): result is { model: (typeof TRIAGE_MODELS)[number]; answers: ClefAnswers } => result.answers !== null));
}
