// ADR-0005 amendment 4, decision 34: cancel one round and its descendants, and nothing else.

import { type MessageId, type RunId, isTerminal } from "@deskmates/contracts";
import type { RunStore } from "../ledger/runs.js";
import type { RoundPlanStore } from "./round-plans.js";
import type { RoundStore } from "./rounds.js";
import type { RoutingWalkStore } from "./routing-walks.js";

export interface RoundCancelDeps {
  rounds: RoundStore;
  runs: RunStore;
  walks: RoutingWalkStore;
  /** Triaged rounds (ADR-0005 amendment 6): their triage job and closer wake go with them. */
  plans?: RoundPlanStore;
  /** The scheduler's cancel: transitions the run and stops a live sidecar. */
  cancelRun: (runId: RunId, by: string) => void;
}

export interface RoundCancelResult {
  rounds: MessageId[];
  cancelled: RunId[];
  /** Runs left alone because they also answer a round outside the cancelled set. */
  kept: RunId[];
}

export function cancelRound(
  deps: RoundCancelDeps,
  messageId: MessageId,
  by: string,
): RoundCancelResult {
  // Stamp first: from here on no coalesce, walk step or retry can relate a run to these rounds.
  const { rounds, targets } = deps.walks.transaction(() => {
    const tree = deps.rounds.withDescendants(messageId);
    deps.rounds.markCancelled(tree, by);
    for (const id of tree) {
      if (deps.walks.get(id)?.status === "pending") deps.walks.complete(id);
    }
    // A triage job or closer wake serves its round only, so it is never shared.
    const planned = tree.flatMap((id) => {
      const plan = deps.plans?.get(id);
      return [plan?.triageRunId, plan?.closerRunId].flatMap((runId) =>
        runId ? [{ runId, shared: false }] : [],
      );
    });
    return { rounds: tree, targets: [...deps.rounds.runsOf(tree), ...planned] };
  });
  const cancelled: RunId[] = [];
  const kept: RunId[] = [];
  for (const { runId, shared } of targets) {
    const run = deps.runs.get(runId);
    if (!run || isTerminal(run.status)) continue;
    if (shared) {
      kept.push(runId);
      continue;
    }
    deps.cancelRun(runId, by);
    cancelled.push(runId);
  }
  return { rounds, cancelled, kept };
}
