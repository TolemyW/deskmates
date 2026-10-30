// What the web search executor does with a running stack (protocol of 2026-10-18): set the arm's
// workspace switch, decline every approval a run asks for while it runs (nobody is there; an ask
// is an egress ask for a host outside the campaign workspace's list), and observe one finished run
// from its own ledger and the fixture's log. T3/T4 support only: imported by
// `evals/web-search-campaign.acceptance.test.ts`, never by `npm test`.

import type { ApprovalId, RunId, WebSearchView } from "@deskmates/contracts";
import { decideApproval, pendingApprovals } from "../../acceptance/support/approvals.js";
import { POLL_MS, runEvents, toolNameOf } from "../../acceptance/support/runs.js";
import type { Stack } from "../../acceptance/support/start-stack.js";
import { type FixtureLogEntry, fixtureCounts } from "./fixture-server.js";
import type { WebSearchObservation } from "./grade.js";

/** ADR-0049 decision 4: the arm's switch, and a check that the Gateway sees search configured. */
export async function setWebSearchSwitch(stack: Stack, on: boolean): Promise<WebSearchView> {
  const res = await stack.api<{ webSearch: WebSearchView }>(
    "PUT",
    `/api/workspaces/${stack.workspace.id}/web-search`,
    { enabled: on },
  );
  if (res.status !== 200)
    throw new Error(`web search switch: ${res.status} ${JSON.stringify(res.json)}`);
  if (!res.json.webSearch.configured) throw new Error("harness: SEARCH_URL is not configured");
  if (res.json.webSearch.effective !== on) throw new Error("harness: the switch did not take");
  return res.json.webSearch;
}

/**
 * Deny every pending approval of `runId` until `stop` resolves, the way an absent human's ask
 * would end, so a run that asks to leave the fixture is not parked for the whole short wait.
 */
export function declineApprovalsWhile(
  stack: Stack,
  runId: () => string | undefined,
  stop: Promise<unknown>,
): Promise<number> {
  let done = false;
  void stop.finally(() => {
    done = true;
  });
  return (async () => {
    let declined = 0;
    while (!done) {
      const id = runId();
      if (id)
        for (const a of await pendingApprovals(stack))
          if (a.runId === id) {
            await decideApproval(stack, a.id as ApprovalId, "deny", "evaluation: nobody is here");
            declined += 1;
          }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    return declined;
  })();
}

/** Everything of one finished run the grader needs: its ledger, and what the fixture served. */
export async function observeWebSearchRun(
  stack: Stack,
  runId: string,
  served: readonly FixtureLogEntry[],
): Promise<
  Pick<
    WebSearchObservation,
    "status" | "finalReply" | "toolCalls" | "searches" | "pagesOpened" | "egressAsks"
  >
> {
  const ctx = stack.app.deskmates.ctx;
  const run = ctx.runs.mustGet(runId as RunId);
  const events = await runEvents(stack, runId);
  const toolCalls: Record<string, number> = {};
  for (const e of events)
    if (e.kind === "tool_call") toolCalls[toolNameOf(e)] = (toolCalls[toolNameOf(e)] ?? 0) + 1;
  const egress = ctx.db
    .prepare("SELECT COUNT(*) AS n FROM approvals WHERE run_id = ? AND kind = 'egress'")
    .get(runId) as { n: number };
  const counts = fixtureCounts(served);
  return {
    status: run.status,
    finalReply: run.summary?.reply ?? null,
    toolCalls,
    searches: counts.searches,
    pagesOpened: counts.pagesOpened,
    egressAsks: egress.n,
  };
}
