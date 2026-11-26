// Workers AI cost accounting. Prices are the published $-per-million-token
// rates for each model; Cloudflare bills them as neurons at $0.011 per 1,000
// neurons, with 10,000 neurons per day included free.

import type { Env } from "./types";

export const FREE_DAILY_NEURONS = 10_000;
const USD_PER_NEURON = 0.011 / 1_000;

interface ModelPrice {
  inPerM: number;
  cachedInPerM: number;
  outPerM: number;
}

const MODEL_PRICES: Record<string, ModelPrice> = {
  "@cf/deepseek-ai/deepseek-v4-flash-0731": { inPerM: 0.44, cachedInPerM: 0.014, outPerM: 1.32 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { inPerM: 0.29, cachedInPerM: 0.29, outPerM: 2.25 },
  "@cf/meta/llama-3.1-8b-instruct-fast": { inPerM: 0.045, cachedInPerM: 0.045, outPerM: 0.384 },
  // Decision models: billed for input only.
  "@cf/cloudflare/clef": { inPerM: 0.24, cachedInPerM: 0.24, outPerM: 0 },
  "@cf/cloudflare/clef-flash": { inPerM: 0.038, cachedInPerM: 0.038, outPerM: 0 },
  "@cf/zai-org/glm-5.3-flash": { inPerM: 0.15, cachedInPerM: 0.15, outPerM: 0.5 },
};

export interface RunUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface RunCost {
  costUsd: number;
  neurons: number;
}

export function priceRun(model: string, usage: RunUsage): RunCost {
  const price = MODEL_PRICES[model] ?? { inPerM: 1, cachedInPerM: 1, outPerM: 3 };
  const freshInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const costUsd = (freshInput * price.inPerM
    + usage.cachedInputTokens * price.cachedInPerM
    + usage.outputTokens * price.outPerM) / 1_000_000;
  return { costUsd, neurons: costUsd / USD_PER_NEURON };
}

export interface AiRunRecord {
  kind: "agent" | "kg-sync" | "spam" | "triage" | "draft" | "brief";
  keyId: string | null;
  model: string;
  prompt: string | null;
  identity: string | null;
  toolCalls: number | null;
  usage: RunUsage;
  durationMs: number;
}

export async function recordAiRun(env: Env, record: AiRunRecord): Promise<RunCost> {
  const cost = priceRun(record.model, record.usage);
  await env.DB.prepare(`INSERT INTO ai_runs
    (id, kind, key_id, model, prompt, identity, tool_calls, input_tokens, cached_input_tokens,
     output_tokens, neurons, cost_usd, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), record.kind, record.keyId, record.model,
      record.prompt?.slice(0, 500) ?? null, record.identity, record.toolCalls,
      record.usage.inputTokens, record.usage.cachedInputTokens, record.usage.outputTokens,
      cost.neurons, cost.costUsd, record.durationMs).run();
  return cost;
}

export interface DailyNeurons {
  usedToday: number;
  freeDaily: number;
  // Cloudflare's free allocation resets at 00:00 UTC.
  windowStartUtc: string;
}

export async function dailyNeurons(env: Env): Promise<DailyNeurons> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(neurons), 0) AS used FROM ai_runs WHERE created_at >= date('now')")
    .first<{ used: number }>();
  return {
    usedToday: Math.round((row?.used ?? 0) * 10) / 10,
    freeDaily: FREE_DAILY_NEURONS,
    windowStartUtc: `${new Date().toISOString().slice(0, 10)}T00:00:00Z`,
  };
}

// What the autopilot (triage, drafts, brief) spent since 00:00 UTC.
export async function autopilotSpendToday(env: Env): Promise<number> {
  const row = await env.DB.prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_runs
    WHERE kind IN ('triage', 'draft', 'brief') AND created_at >= date('now')`).first<{ spent: number }>();
  return row?.spent ?? 0;
}
