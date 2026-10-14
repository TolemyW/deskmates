// The approval side of the Gateway's operator API, the way a human at the web UI drives it
// (ADR-0002 amendment 2): list what is pending, decide one, read a bot's stored rules. Used by
// `m1-approvals.acceptance.test.ts`; the sidecar side (the PreToolUse hook, the short wait, the
// park and the resume) is only ever observed here through run status, `Run.attempt` and the
// ledger.

import type {
  Approval,
  ApprovalDecision,
  ApprovalId,
  ApprovalRule,
  BotId,
  RunId,
  ThreadId,
} from "@deskmates/contracts";
import { PARKED_RUN_STATUSES, isTerminal } from "@deskmates/contracts";
import { POLL_MS, type RunView, type RunWaitOptions, getRun } from "./runs.js";
import type { Stack } from "./start-stack.js";

/** `GET /api/approvals?status=pending`, optionally narrowed to one thread. */
export async function pendingApprovals(stack: Stack, threadId?: ThreadId): Promise<Approval[]> {
  const query = new URLSearchParams({ status: "pending" });
  if (threadId !== undefined) query.set("threadId", String(threadId));
  const res = await stack.api<{ approvals: Approval[] }>("GET", `/api/approvals?${query}`);
  if (res.status !== 200) {
    throw new Error(`list approvals: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json.approvals;
}

export interface DecideResult {
  approval: Approval;
  /** Present when the decision was `allow_always`: the rule the Gateway stored for the bot. */
  rule?: ApprovalRule;
}

/** `POST /api/approvals/:id/decide`. The operator API's author is the human `web`. */
export async function decideApproval(
  stack: Stack,
  id: ApprovalId,
  decision: ApprovalDecision,
  reason?: string,
): Promise<DecideResult> {
  const res = await stack.api<DecideResult>("POST", `/api/approvals/${id}/decide`, {
    decision,
    ...(reason === undefined ? {} : { reason }),
  });
  if (res.status !== 200) {
    throw new Error(`decide approval: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json;
}

/** `GET /api/bots/:id/approval-rules`: the "Always" decisions stored for one bot, oldest first. */
/**
 * `POST /api/bots/:id/approval-rules`: store a rule ahead of time, the way an operator would from
 * the rules editor. A suite whose subject is not the approval itself (takeover, for one) stores an
 * `allow_always` rule for the L2 click before posting the task, so the run never waits on a
 * decision nobody is there to give.
 */
export async function storeApprovalRule(
  stack: Stack,
  botId: BotId,
  matcher: ApprovalRule["matcher"],
  decision: ApprovalRule["decision"] = "allow_always",
): Promise<ApprovalRule> {
  const res = await stack.api<{ rule: ApprovalRule }>("POST", `/api/bots/${botId}/approval-rules`, {
    matcher,
    decision,
  });
  if (res.status !== 201) {
    throw new Error(`store approval rule: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json.rule;
}

export async function approvalRules(stack: Stack, botId: BotId): Promise<ApprovalRule[]> {
  const res = await stack.api<{ rules: ApprovalRule[] }>(
    "GET",
    // A numbered page since #113 slice B; an acceptance bot holds far fewer than 100 rules.
    `/api/bots/${botId}/approval-rules?limit=100`,
  );
  if (res.status !== 200) {
    throw new Error(`list approval rules: ${res.status} ${JSON.stringify(res.json)}`);
  }
  return res.json.rules;
}

const APPROVAL_POLL_MS = POLL_MS;

/**
 * The run's pending approval, once the Gateway has one. Polls fast, because with a short wait of
 * a couple of seconds the request is posted and the run parks in quick succession.
 *
 * Only ever this run's approval: the list is filtered by `runId` and by nothing else, so a
 * parked run left over from an earlier case can never be mistaken for this one's. (It used to be
 * narrowed by the stack's default thread instead, which both missed a case running in its own
 * thread and matched another run in the default one.)
 *
 * Returns `undefined` when the run reached a terminal state, or parked without a pending
 * approval: either way nothing is left to decide. A parked run *with* a pending approval is
 * returned rather than dropped — parking is exactly what the hook does when nobody answered in
 * the short wait, and the decision still resumes the run (ADR-0002 decision 2). So a caller can
 * use this helper without racing the short wait.
 */
export async function waitForPendingApproval(
  stack: Stack,
  runId: RunId,
  timeoutMs: number,
): Promise<Approval | undefined> {
  const deadline = Date.now() + timeoutMs;
  const forRun = async (): Promise<Approval | undefined> =>
    (await pendingApprovals(stack)).find((a) => a.runId === runId);
  for (;;) {
    const found = await forRun();
    if (found) return found;
    const { run } = await getRun(stack, runId);
    if (isTerminal(run.status) || PARKED_RUN_STATUSES.has(run.status)) {
      // The status change and the approval row are two writes; look once more before giving up.
      return await forRun();
    }
    if (Date.now() > deadline) {
      throw new Error(`no pending approval for run ${runId} after ${timeoutMs} ms (${run.status})`);
    }
    await new Promise((r) => setTimeout(r, APPROVAL_POLL_MS));
  }
}

/**
 * Poll until the run is terminal, ignoring the parked states `waitForRun` stops on: after a
 * decision a parked run is resumed in the same row, so the caller wants the end of the run, not
 * the park it came through.
 *
 * With `failIfParkedAgain` (the default here, because every caller has just decided something)
 * a *second* park fails the wait at once instead of burning the timeout: a park observed after
 * the run was seen running again, or a park carrying `attempt` ≥ 2. The error names the run and
 * whatever is pending on it, which is the question a reader of the failure asks next.
 */
export async function waitForRunEnd(
  stack: Stack,
  runId: RunId,
  timeoutMs: number,
  options: RunWaitOptions = {},
): Promise<RunView> {
  const failIfParkedAgain = options.failIfParkedAgain ?? true;
  const deadline = Date.now() + timeoutMs;
  let last: RunView["status"] | undefined;
  let sawRunningAgain = false;
  for (;;) {
    const { run } = await getRun(stack, runId);
    if (run.status !== last) {
      last = run.status;
      options.onStatus?.(run.status);
    }
    if (isTerminal(run.status)) return run;
    if (
      failIfParkedAgain &&
      run.status === "waiting_approval" &&
      (sawRunningAgain || run.attempt >= 2)
    ) {
      const pending = (await pendingApprovals(stack)).filter((a) => a.runId === runId);
      const detail =
        options.describeParked !== undefined
          ? await options.describeParked(run)
          : pending.length === 0
            ? "nothing pending"
            : pending
                .map((a) => `${a.id} ${String(a.action.toolName)} (${a.action.argumentSummary})`)
                .join(", ");
      throw new Error(
        `run ${runId} parked a second time (attempt ${run.attempt}) waiting on ${detail}`,
      );
    }
    if (!PARKED_RUN_STATUSES.has(run.status)) sawRunningAgain = true;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} still ${run.status} after ${timeoutMs} ms`);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Ledger `approval` events of one run, in ledger order, as `phase` strings. */
export function approvalPhases(events: readonly { kind: string; payload: unknown }[]): string[] {
  return events
    .filter((e) => e.kind === "approval")
    .map((e) => (e.payload as { phase?: unknown }).phase)
    .filter((p): p is string => typeof p === "string");
}
