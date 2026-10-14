// T1: the L2 short wait survives a wobbling Gateway and stops when the SDK stops (review M3, L4).

import type { ApprovalId, ApprovalRequest, RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { waitForApproval } from "./approval-wait.js";
import { GatewayClient } from "./gateway-client.js";
import {
  type FakeGateway,
  type FakeGatewayOptions,
  createFakeGateway,
} from "./testing/fake-gateway.js";

const RUN_ID = "run-1" as RunId;
const APPROVAL_ID = "ap-1" as ApprovalId;

const request: ApprovalRequest = {
  type: "approval_request",
  runId: RUN_ID,
  approvalId: APPROVAL_ID,
  action: { toolName: "Bash", input: { command: "git push origin main" } },
  riskLevel: "L2",
};

function setup(opts: FakeGatewayOptions): { gw: FakeGateway; client: GatewayClient } {
  const gw = createFakeGateway(opts);
  return { gw, client: new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, "tok") };
}

/** A clock that moves 250 ms per read, so waits elapse without real sleeping. */
function fakeClock(stepMs = 250): () => Date {
  let t = Date.parse("2026-09-21T10:00:00Z");
  return () => {
    t += stepMs;
    return new Date(t);
  };
}

describe("waitForApproval: a failing poll is not a decision (review M3)", () => {
  it("keeps waiting through a 503 and returns the decision that follows", async () => {
    const { gw, client } = setup({
      failApprovalPolls: 1,
      approvalResponder: (req) => {
        // The human answers while the Gateway is still wobbling.
        gw.decide({ type: "approval_response", approvalId: req.approvalId, decision: "allow" });
        return "pending";
      },
    });
    const errors: unknown[] = [];
    const result = await waitForApproval(request, {
      client,
      now: fakeClock(),
      sleep: async () => {},
      shortWaitMs: 60_000,
      pollMs: 1,
      onPollError: (err) => errors.push(err),
    });

    expect(result).toEqual({
      kind: "decided",
      response: { type: "approval_response", approvalId: APPROVAL_ID, decision: "allow" },
    });
    // the first poll failed and was swallowed, the second carried the decision
    expect(gw.attempts.approvalPolls).toBe(2);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain("HTTP 503");
  });

  it("still times out at the deadline when every poll fails", async () => {
    const { gw, client } = setup({ failApprovalPolls: 999, approvalResponder: () => "pending" });
    const result = await waitForApproval(request, {
      client,
      now: fakeClock(),
      sleep: async () => {},
      shortWaitMs: 1000,
      pollMs: 1,
    });
    expect(result).toEqual({ kind: "timeout" });
    expect(gw.attempts.approvalPolls).toBeGreaterThan(0);
  });

  it("reports an error, not a timeout, when the request itself never lands", async () => {
    const { gw, client } = setup({ failApprovalPosts: 999 });
    const result = await waitForApproval(request, {
      client,
      now: fakeClock(),
      sleep: async () => {},
      shortWaitMs: 1000,
      pollMs: 1,
    });
    expect(result.kind).toBe("error");
    // it never polls for an approval the Gateway never accepted
    expect(gw.attempts.approvalPolls).toBe(0);
  });
});

describe("waitForApproval: the SDK's hook signal ends the wait (review M3)", () => {
  it("returns timeout at once when the signal is already aborted", async () => {
    const { gw, client } = setup({ approvalResponder: () => "pending" });
    const controller = new AbortController();
    controller.abort();
    const result = await waitForApproval(request, {
      client,
      now: () => new Date("2026-09-21T10:00:00Z"),
      sleep: async () => {},
      shortWaitMs: 300_000,
      pollMs: 1,
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: "timeout" });
    expect(gw.attempts.approvalPolls).toBe(0);
  });

  it("stops mid-wait when the signal fires, long before the deadline", async () => {
    const { gw, client } = setup({ approvalResponder: () => "pending" });
    const controller = new AbortController();
    let sleeps = 0;
    const result = await waitForApproval(request, {
      client,
      // A clock that never moves: only the signal can end this wait.
      now: () => new Date("2026-09-21T10:00:00Z"),
      sleep: async () => {
        sleeps += 1;
        if (sleeps === 2) controller.abort();
      },
      shortWaitMs: 300_000,
      pollMs: 1,
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: "timeout" });
    expect(gw.attempts.approvalPolls).toBe(1);
  });
});

describe("waitForApproval: onPoll runs once per iteration (review L4)", () => {
  it("calls onPoll before each poll and survives a rejection from it", async () => {
    const { gw, client } = setup({ approvalResponder: () => "pending" });
    const order: string[] = [];
    const errors: unknown[] = [];
    await waitForApproval(request, {
      client,
      now: fakeClock(),
      sleep: async () => {},
      shortWaitMs: 1000,
      pollMs: 1,
      onPoll: async () => {
        order.push(`renew-${gw.attempts.approvalPolls}`);
        throw new Error("lock renew failed");
      },
      onPollError: (err) => errors.push(err),
    });
    // one renew before every poll, and a renew that throws does not end the wait
    expect(order).toEqual(["renew-0", "renew-1", "renew-2"]);
    expect(gw.attempts.approvalPolls).toBe(3);
    expect(errors).toHaveLength(3);
  });
});
