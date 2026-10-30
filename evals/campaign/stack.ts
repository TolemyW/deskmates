// What both campaign executors of the 2026-10-17 protocol share once a stack is up: the switch
// that keeps them from running, the campaign's configuration from `.env` and per-run accounting.
// The ceiling gate is `gate.ts`; the stop-rule check and the report files are `report-dir.ts`.
// T3/T4 support only: imported by the two `*-campaign.acceptance.test.ts` files, never by
// `npm test`.

import { type RunId, isTerminal } from "@deskmates/contracts";
import { type GatewayConfig, loadConfig } from "@deskmates/gateway";
import { POLL_MS } from "../../acceptance/support/runs.js";
import type { Stack } from "../../acceptance/support/start-stack.js";

/**
 * A campaign runs only when `EVAL_CAMPAIGN` names it. `npm test` never loads these files and
 * `npm run test:acceptance` skips them without it, so no default command reaches a model.
 */
export function campaignRequested(id: string, env = process.env): boolean {
  return (env.EVAL_CAMPAIGN ?? "").trim() === id;
}

/**
 * The installation configuration a campaign reads from its environment, the way the Gateway's
 * own `loadConfig` reads `.env`, with the arm's variables laid over it. The operator token is a
 * placeholder: the stack mints its own.
 */
export function campaignConfig(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Pick<GatewayConfig, "modelPrices" | "retrieval" | "modelUpstreams" | "cheapModel" | "search"> {
  const config = loadConfig({
    GATEWAY_OPERATOR_TOKEN: "evaluation-campaign-placeholder-token-32b",
    ...env,
    ...overrides,
  });
  return {
    modelPrices: config.modelPrices,
    cheapModel: config.cheapModel,
    ...(config.retrieval ? { retrieval: config.retrieval } : {}),
    ...(config.modelUpstreams ? { modelUpstreams: config.modelUpstreams } : {}),
    ...(config.search ? { search: config.search } : {}),
  };
}

/** Refuse to start when a model the campaign pays for has no price row (stop rule S2 upfront). */
export function requirePrices(stack: Stack, models: readonly string[]): void {
  for (const model of models)
    if (stack.app.deskmates.ctx.prices.listForModel(model).length === 0)
      throw new Error(`no MODEL_PRICES row for ${model}: its cost would be unknown`);
}

export interface Accounting {
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  servedModels: string[];
  wallMs: number | null;
}

/** Tokens and Gateway-priced cost of one run; any unpriced part makes the cost unknown. */
export async function accounting(stack: Stack, runId: string): Promise<Accounting> {
  const res = await stack.api<{
    run: { startedAt?: string; finishedAt?: string };
    usage: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }[];
    usageCoverage: string;
  }>("GET", `/api/runs/${runId}`);
  const usage = res.json.usage ?? [];
  const sum = (key: "inputTokens" | "outputTokens" | "costUsd") =>
    usage.some((u) => u[key] === null) ? null : usage.reduce((a, u) => a + (u[key] ?? 0), 0);
  const complete =
    res.json.usageCoverage === "complete" || res.json.usageCoverage === "not_started";
  const served = stack.app.deskmates.ctx.db
    .prepare(
      "SELECT DISTINCT served_model AS m FROM model_requests WHERE run_id = ? AND served_model IS NOT NULL ORDER BY m",
    )
    .all(runId) as { m: string }[];
  const { startedAt, finishedAt } = res.json.run ?? {};
  return {
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    costUsd: complete ? sum("costUsd") : null,
    servedModels: served.map((r) => r.m),
    wallMs: startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : null,
  };
}

/** Runs the Gateway started because of `runId` (activity summaries of it), with their cost. */
export async function followUpCost(
  stack: Stack,
  runId: string,
  timeoutMs = 60_000,
): Promise<number | null> {
  const ctx = stack.app.deskmates.ctx;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const jobs = (
      ctx.db
        .prepare("SELECT id, status FROM runs WHERE json_extract(config_json, '$.sourceRunId') = ?")
        .all(runId) as { id: string; status: string }[]
    ).map((r) => ctx.runs.mustGet(r.id as RunId));
    const open = jobs.filter((j) => !isTerminal(j.status));
    if (open.length === 0 || Date.now() > deadline) {
      let total = 0;
      for (const job of jobs) {
        const cost = (await accounting(stack, job.id)).costUsd;
        if (cost === null) return null;
        total += cost;
      }
      return open.length === 0 ? total : null;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
