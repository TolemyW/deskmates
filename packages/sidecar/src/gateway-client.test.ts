// T1: the Gateway HTTP client's deadlines and the one retry on the approval post (review M3).

import {
  type ApprovalId,
  type ApprovalRequest,
  DeskmatesError,
  type RunId,
} from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { GATEWAY_TIMEOUT_MS, GatewayClient } from "./gateway-client.js";
import { createFakeGateway } from "./testing/fake-gateway.js";

const RUN_ID = "run-1" as RunId;
const TOKEN = "deskmates-run-token-9f3c2a1b7e";

function approvalRequest(): ApprovalRequest {
  return {
    type: "approval_request",
    runId: RUN_ID,
    approvalId: "ap-1" as ApprovalId,
    action: { toolName: "Bash", input: { command: "git push" } },
    riskLevel: "L2",
  };
}

/** A Gateway that accepts the connection and never answers; only an abort ends the request. */
const hangingFetch: typeof globalThis.fetch = (_input, init) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return; // no deadline: this request would hang the run forever
    signal.addEventListener("abort", () => reject(new Error("TimeoutError: aborted")), {
      once: true,
    });
  });

describe("GatewayClient deadlines", () => {
  it("has a 10 s default deadline", () => {
    expect(GATEWAY_TIMEOUT_MS).toBe(10_000);
  });

  it("puts an AbortSignal on every request", async () => {
    const gw = createFakeGateway();
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    await client.postEnded({ type: "run_ended", runId: RUN_ID, outcome: "completed", usage: [] });
    await client.browserLock({ type: "browser_lock", runId: RUN_ID, op: "acquire" });
    await client.getApproval("ap-1" as ApprovalId);
    expect(gw.requests).toHaveLength(3);
    for (const r of gw.requests) expect(r.hasSignal).toBe(true);
  });

  it.each([
    [
      "postEnded",
      (c: GatewayClient) =>
        c.postEnded({ type: "run_ended", runId: RUN_ID, outcome: "completed", usage: [] }),
    ],
    ["getApproval", (c: GatewayClient) => c.getApproval("ap-1" as ApprovalId)],
    [
      "postEvents",
      (c: GatewayClient) =>
        c.postEvents([
          {
            type: "event",
            runId: RUN_ID,
            attempt: 1,
            seq: 1,
            kind: "log",
            payload: {},
            ts: "2026-09-21T10:00:00.000Z",
          },
        ]),
    ],
    [
      "browserLock",
      (c: GatewayClient) => c.browserLock({ type: "browser_lock", runId: RUN_ID, op: "acquire" }),
    ],
    [
      "browserOrigin",
      (c: GatewayClient) =>
        c.browserOrigin({
          type: "browser_origin",
          runId: RUN_ID,
          op: "acquire",
          origin: "https://ops.test",
        }),
    ],
    [
      "postMessage",
      (c: GatewayClient) =>
        c.postMessage({
          type: "post_message",
          runId: RUN_ID,
          tool: "thread_post",
          body: "hi",
          attachments: [],
        }),
    ],
  ])("%s rejects instead of hanging when the Gateway never answers", async (_name, call) => {
    const client = new GatewayClient(hangingFetch, "http://gateway.test", RUN_ID, TOKEN, {
      timeoutMs: 20,
    });
    await expect(call(client)).rejects.toThrow();
  });

  it("times the approval post out too, after its one retry", async () => {
    const client = new GatewayClient(hangingFetch, "http://gateway.test", RUN_ID, TOKEN, {
      timeoutMs: 20,
    });
    await expect(client.requestApproval(approvalRequest())).rejects.toThrow();
  });
});

describe("GatewayClient.browserOrigin", () => {
  it("posts to the origin route and composes caller cancellation with the transport timeout", async () => {
    let seenSignal: AbortSignal | null = null;
    const fetchFn: typeof globalThis.fetch = async (_input, init) => {
      seenSignal = init?.signal ?? null;
      return new Response(
        JSON.stringify({
          type: "browser_origin_result",
          runId: RUN_ID,
          granted: true,
          origin: "https://ops.test",
        }),
        { status: 200 },
      );
    };
    const controller = new AbortController();
    const client = new GatewayClient(fetchFn, "http://gateway.test", RUN_ID, TOKEN);
    const result = await client.browserOrigin(
      { type: "browser_origin", runId: RUN_ID, op: "acquire", origin: "https://ops.test" },
      controller.signal,
    );
    expect(result.granted).toBe(true);
    controller.abort();
    expect(seenSignal).not.toBeNull();
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
  });
});

describe("GatewayClient.postTimings", () => {
  it("posts attempt-scoped events without a sidecar sequence", async () => {
    let body: unknown;
    const fetchFn: typeof globalThis.fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 204 });
    };
    const client = new GatewayClient(fetchFn, "http://gateway.test", RUN_ID, TOKEN);
    await client.postTimings(
      [
        {
          source: "phase_timing",
          version: 1,
          spanId: "span-1",
          phase: "browser_rpc",
          edge: "start",
          at: "2026-09-23T10:00:00.000Z",
          toolName: "browser_click",
        },
      ],
      2,
    );
    expect(body).toEqual([
      {
        type: "event",
        runId: RUN_ID,
        attempt: 2,
        kind: "log",
        payload: expect.objectContaining({ source: "phase_timing", spanId: "span-1" }),
        ts: "2026-09-23T10:00:00.000Z",
      },
    ]);
    expect((body as Record<string, unknown>[])[0]).not.toHaveProperty("seq");
  });
});

describe("GatewayClient.requestApproval retries once", () => {
  it("survives one transient failure and still returns the decision", async () => {
    const gw = createFakeGateway({
      failApprovalPosts: 1,
      approvalResponder: (req) => ({
        type: "approval_response",
        approvalId: req.approvalId,
        decision: "allow",
      }),
    });
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    const res = await client.requestApproval(approvalRequest());
    expect(res?.decision).toBe("allow");
    expect(gw.attempts.approvalPosts).toBe(2);
    expect(gw.approvals).toHaveLength(1);
  });

  it("gives up after the second failure rather than retrying forever", async () => {
    const gw = createFakeGateway({ failApprovalPosts: 5 });
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    await expect(client.requestApproval(approvalRequest())).rejects.toThrow(/HTTP 503/);
    expect(gw.attempts.approvalPosts).toBe(2);
  });
});

describe("GatewayClient.getEgressAllowlist", () => {
  it("reads the workspace's current list from the run's egress route", async () => {
    const gw = createFakeGateway({ egressAllowlist: () => ["ops.example.test"] });
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    const res = await client.getEgressAllowlist();
    expect(res.type).toBe("egress_allowlist");
    expect(res.egressAllowlist).toEqual(["ops.example.test"]);
    expect(res.updatedAt).toEqual(expect.any(String));
    const req = gw.requests[0];
    expect(req?.method).toBe("GET");
    expect(req?.url).toBe("http://gateway.test/internal/runs/run-1/egress");
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.hasSignal).toBe(true);
    expect(gw.attempts.egressGets).toBe(1);
  });

  it("throws with the status rather than returning a list the Gateway did not send", async () => {
    const gw = createFakeGateway({ egressStatus: 500 });
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    await expect(client.getEgressAllowlist()).rejects.toThrow(/HTTP 500/);
  });

  it("rejects instead of hanging when the Gateway never answers", async () => {
    const client = new GatewayClient(hangingFetch, "http://gateway.test", RUN_ID, TOKEN, {
      timeoutMs: 20,
    });
    await expect(client.getEgressAllowlist()).rejects.toThrow();
  });
});

describe("GatewayClient.decideApproval (ADR-0002 amendment 2, A2)", () => {
  const decide = {
    type: "approval_decide",
    runId: RUN_ID,
    approvalId: "ap 1" as ApprovalId,
    decision: "allow_always",
    reason: "the order is the one Alice asked for",
  } as const;

  it("posts the decision to the approval's decide route with the run's token", async () => {
    const gw = createFakeGateway();
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    await client.decideApproval(decide);
    expect(gw.decides).toEqual([decide]);
    const req = gw.requests[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("http://gateway.test/internal/runs/run-1/approvals/ap%201/decide");
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.hasSignal).toBe(true);
  });

  it("throws with the status when the Gateway refuses the decision", async () => {
    const gw = createFakeGateway({ approvalDecideStatus: 403 });
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    await expect(client.decideApproval(decide)).rejects.toThrow(/HTTP 403/);
  });

  it("keeps the Gateway's code, message and details when it refuses with a Deskmates body", async () => {
    // The second-decision answer of approvals.ts: a 409 naming the decision and the decider.
    // "HTTP 409" alone leaves the deciding bot nothing to act on but a retry.
    const gw = createFakeGateway({
      approvalDecideStatus: 409,
      approvalDecideError: {
        code: "invalid_transition",
        message: "approval ap 1 was already allow_once",
        details: { approvalId: "ap 1", decision: "allow_once", decidedBy: "bot:ada" },
      },
    });
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    const err = await client.decideApproval(decide).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeskmatesError);
    expect((err as DeskmatesError).code).toBe("invalid_transition");
    expect((err as DeskmatesError).message).toBe("approval ap 1 was already allow_once");
    expect((err as DeskmatesError).details).toEqual({
      approvalId: "ap 1",
      decision: "allow_once",
      decidedBy: "bot:ada",
      status: 409,
    });
  });

  it("keeps the status-only message when the refusal body is not a Deskmates error", async () => {
    const gw = createFakeGateway({
      approvalDecideStatus: 409,
      approvalDecideError: { code: "something_else", message: "not a Deskmates code" },
    });
    const client = new GatewayClient(gw.fetch, "http://gateway.test", RUN_ID, TOKEN);
    const err = await client.decideApproval(decide).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(DeskmatesError);
    expect(String(err)).toMatch(/HTTP 409/);
  });
});
