// The two admission checkpoints of the workspace budget (ADR-0032 decisions 5 and 6): before a
// run starts or resumes (the scheduler) and before each model call (the model proxy). Both open
// the same park and log the same event, so the ledger tells where the work stopped.

import type { BudgetCheckpoint, RunId } from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import type { BudgetVerdict } from "./budget-store.js";

function parkAndLog(
  ctx: GatewayContext,
  run: RunRecord,
  checkpoint: BudgetCheckpoint,
  verdict: BudgetVerdict,
): void {
  const park = ctx.budget.park(run.id, run.attempt, checkpoint, verdict);
  if (!park.created) return;
  ctx.events.append({
    runId: run.id,
    attempt: run.attempt,
    kind: "log",
    payload: {
      source: "budget",
      phase: "parked",
      checkpoint,
      parkId: park.id,
      limitKind: verdict.exhausted,
      limitUsd: verdict.limitUsd,
      spendUsd: verdict.spendUsd,
      weekStartsAt: verdict.weekStartsAt,
    },
  });
}

/** Model proxy: a refusal body when the run's workspace is exhausted, after parking the run. */
export function budgetAdmission(
  ctx: GatewayContext,
  runId: RunId,
): { message: string; details: Record<string, unknown> } | undefined {
  const run = ctx.runs.mustGet(runId);
  const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
  const verdict = ctx.budget.verdict(workspaceId);
  if (!verdict.exhausted) return undefined;
  parkAndLog(ctx, run, "model_call", verdict);
  return {
    message: `the workspace's ${verdict.exhausted} budget is exhausted; the run is parked until an Admin continues it`,
    details: {
      limitKind: verdict.exhausted,
      limitUsd: verdict.limitUsd,
      spendUsd: verdict.spendUsd,
    },
  };
}

/** Scheduler: true when the run was parked instead of started. */
export function parkIfExhausted(ctx: GatewayContext, run: RunRecord): boolean {
  const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
  const verdict = ctx.budget.verdict(workspaceId);
  if (!verdict.exhausted) return false;
  parkAndLog(ctx, run, "admission", verdict);
  return true;
}
