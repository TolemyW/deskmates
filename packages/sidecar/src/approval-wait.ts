// The short wait for an L2 approval (ADR-0002 decision 2). Post the request, then poll the
// Gateway every `pollMs` until it answers or `shortWaitMs` elapses. The Gateway answers `defer`
// at once when no human is online (ADR-0002 definitions), so an offline workspace never waits.
//
// The wait is the longest-lived thing in a run, so it survives a Gateway that wobbles: a poll that
// throws (a 503, a dropped socket, a per-request timeout) is treated as "still pending" and the
// loop keeps going to the deadline. Only the initial post can end the wait early with an error,
// because without it the Gateway has no approval for a human to answer.

import type { ApprovalRequest, ApprovalResponse } from "@deskmates/contracts";
import type { GatewayClient } from "./gateway-client.js";

export const APPROVAL_POLL_MS = 2000;

export interface ApprovalWaitDeps {
  client: GatewayClient;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  shortWaitMs: number;
  pollMs?: number;
  /**
   * Run once per poll iteration, before the poll itself. The hook uses it to renew the workspace
   * browser lock, whose TTL is shorter than the short wait. A rejection is reported and ignored.
   */
  onPoll?: () => Promise<void>;
  /**
   * The SDK hook's abort signal (third hook argument). When it fires the wait ends as `timeout`,
   * so the run parks on the approval instead of the hook dying with the query.
   */
  signal?: AbortSignal;
  /** Called for every swallowed poll or `onPoll` failure, for the ledger and stderr. */
  onPollError?: (err: unknown) => void;
}

export type ApprovalWaitResult =
  | { kind: "decided"; response: ApprovalResponse }
  /** The short wait elapsed, or the SDK aborted the hook: park the run. */
  | { kind: "timeout" }
  /** The approval could not be posted at all; there is nothing for a human to answer. */
  | { kind: "error"; error: unknown };

export async function waitForApproval(
  req: ApprovalRequest,
  deps: ApprovalWaitDeps,
): Promise<ApprovalWaitResult> {
  const pollMs = deps.pollMs ?? APPROVAL_POLL_MS;
  const started = deps.now().getTime();

  let immediate: ApprovalResponse | undefined;
  try {
    immediate = await deps.client.requestApproval(req);
  } catch (error) {
    return { kind: "error", error };
  }
  if (immediate) return { kind: "decided", response: immediate };

  for (;;) {
    if (deps.signal?.aborted) return { kind: "timeout" };
    const elapsed = deps.now().getTime() - started;
    const remaining = deps.shortWaitMs - elapsed;
    if (remaining <= 0) return { kind: "timeout" };
    await deps.sleep(Math.min(pollMs, remaining));
    if (deps.signal?.aborted) return { kind: "timeout" };

    if (deps.onPoll) {
      try {
        await deps.onPoll();
      } catch (err) {
        deps.onPollError?.(err);
      }
    }

    try {
      const response = await deps.client.getApproval(req.approvalId);
      if (response) return { kind: "decided", response };
    } catch (err) {
      // A failed poll says nothing about the human's decision; keep waiting until the deadline.
      deps.onPollError?.(err);
    }
  }
}
