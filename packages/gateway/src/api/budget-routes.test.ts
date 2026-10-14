// T1: the workspace monetary budget end to end (ADR-0032 decisions 1 and 5 to 8). Admission in
// the scheduler and in the model proxy, the budget checkpoint of a run stopped at a model call,
// the manual continue and Stop on parked work. A fake upstream prices one input token at $1.

import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  Run,
  RunEnded,
  RunId,
  StartRunRequest,
  ThreadMessage,
  WorkspaceBudget,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SidecarScript } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

const MODEL = "test-model-default";
let upstream: Server;
let forwarded = 0;
let h: Harness;

function ended(req: StartRunRequest, extra: Partial<RunEnded> = {}): RunEnded {
  return {
    type: "run_ended",
    runId: req.runId,
    outcome: "completed",
    usage: [],
    summary: {
      done: "answered",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "done",
    },
    ...extra,
  } as RunEnded;
}

/** A sidecar that makes one model call per turn and reports what the proxy answered. */
function callOnce(statuses: number[]): SidecarScript {
  return async (req, gw) => {
    const res = await gw.model("/v1/messages", { model: MODEL, max_tokens: 10, messages: [] });
    statuses.push(res.status);
    await res.text();
    await gw.post("ended", ended(req, { sdkSessionId: "sess-1" }));
    return undefined;
  };
}

beforeEach(async () => {
  forwarded = 0;
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    req.resume();
    req.on("end", () => {
      forwarded++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({ id: "msg", model: MODEL, usage: { input_tokens: 3, output_tokens: 0 } }),
      );
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  h = await startHarness({
    modelBaseUrl: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
    modelPrices: [
      {
        model: MODEL,
        inputPerM: 1_000_000,
        outputPerM: 0,
        cacheReadPerM: 0,
        cacheCreatePerM: 0,
        effectiveFrom: "2020-01-01T00:00:00.000Z",
      },
    ],
  });
});

afterEach(async () => {
  await h.close();
  upstream.closeAllConnections();
  await new Promise<void>((r) => upstream.close(() => r()));
});

async function post(threadId: string): Promise<RunId> {
  const posted = await h.api<{ message: ThreadMessage; runs: Run[] }>(
    "POST",
    `/api/threads/${threadId}/messages`,
    { body: "work" },
  );
  expect(posted.status).toBe(201);
  const id = posted.json.runs[0]?.id;
  if (!id) throw new Error("no run");
  return id;
}

const status = (id: RunId) => h.app.deskmates.ctx.runs.mustGet(id).status;

async function budgets(): Promise<WorkspaceBudget[]> {
  return (await h.api<{ budgets: WorkspaceBudget[] }>("GET", "/api/budgets")).json.budgets;
}

describe("workspace budget routes (ADR-0032)", () => {
  it("starts with no limit, validates and audits limit changes (decision 1)", async () => {
    const { workspace } = await h.seed();
    const [initial] = await budgets();
    expect(initial).toMatchObject({
      workspaceId: workspace.id,
      limits: { weeklyLimitUsd: null, cumulativeLimitUsd: null },
      exhausted: null,
      parks: [],
    });
    for (const body of [
      { weeklyLimitUsd: 0 },
      { weeklyLimitUsd: -2 },
      { cumulativeLimitUsd: "9" },
    ]) {
      const res = await h.api<{ code: string }>("PUT", `/api/budgets/${workspace.id}`, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const set = await h.api<{ budget: WorkspaceBudget }>("PUT", `/api/budgets/${workspace.id}`, {
      weeklyLimitUsd: 7.5,
      cumulativeLimitUsd: 100,
    });
    expect(set.status).toBe(200);
    expect(set.json.budget.limits).toEqual({ weeklyLimitUsd: 7.5, cumulativeLimitUsd: 100 });
    const audit = h.app.deskmates.ctx.db
      .prepare("SELECT count(*) AS n FROM audit_events WHERE action = 'budget.set'")
      .get() as { n: number };
    expect(audit.n).toBe(1);
  });

  it("parks a queued run at admission and resumes it only on an explicit continue (decisions 5 to 7)", async () => {
    const { workspace, thread } = await h.seed();
    const statuses: number[] = [];
    h.provider.onRun(callOnce(statuses));
    const first = await post(thread.id);
    await waitFor(() => status(first) === "succeeded", 5000, "first run");
    await h.app.deskmates.scheduler.drain();
    // $3 spent; a $3 weekly limit is reached.
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: 3 });
    const execs = h.provider.execCalls.length;
    const second = await post(thread.id);
    await waitFor(() => h.app.deskmates.ctx.budget.openPark(second) !== undefined, 5000, "park");
    expect(status(second)).toBe("queued");
    expect(h.provider.execCalls.length).toBe(execs);
    const [parked] = await budgets();
    expect(parked).toMatchObject({ exhausted: "weekly", week: { spend: { totalUsd: 3 } } });
    expect(parked?.parks).toEqual([
      expect.objectContaining({
        runId: second,
        checkpoint: "admission",
        limitKind: "weekly",
        limitUsd: 3,
      }),
    ]);
    const refused = await h.api<{ code: string }>(
      "POST",
      `/api/budgets/${workspace.id}/continue`,
      {},
    );
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("budget_exhausted");
    // Raising the limit resumes nothing by itself.
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: 100 });
    h.app.deskmates.scheduler.kick();
    await new Promise((r) => setTimeout(r, 50));
    expect(status(second)).toBe("queued");
    const continued = await h.api<{ continued: RunId[] }>(
      "POST",
      `/api/budgets/${workspace.id}/continue`,
      {},
    );
    expect(continued.status).toBe(200);
    expect(continued.json.continued).toEqual([second]);
    await waitFor(() => status(second) === "succeeded", 5000, "continued run");
  });

  it("refuses a model call when exhausted, checkpoints the run and resumes it with a budget turn (decisions 5 to 8)", async () => {
    const { workspace, thread } = await h.seed();
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: 2 });
    const statuses: number[] = [];
    const triggers: string[] = [];
    let countTokens = 0;
    h.provider.onRun(async (req, gw) => {
      triggers.push(req.trigger.kind);
      if (req.trigger.kind === "budget_continuation") {
        await gw.post("ended", ended(req, { sdkSessionId: "sess-1" }));
        return undefined;
      }
      for (let i = 0; i < 2; i++) {
        const res = await gw.model("/v1/messages", { model: MODEL, max_tokens: 10, messages: [] });
        statuses.push(res.status);
        if (res.status === 402) {
          expect(res.headers.get("x-should-retry")).toBe("false");
          expect(((await res.json()) as { code: string }).code).toBe("budget_exhausted");
        } else await res.text();
      }
      const counted = await gw.model("/v1/messages/count_tokens", { model: MODEL, messages: [] });
      countTokens = counted.status;
      await counted.text();
      // The SDK surfaces the refusal as an error; the reported outcome does not decide the park.
      await gw.post(
        "ended",
        ended(req, { outcome: "failed", error: "API Error: 402", sdkSessionId: "sess-1" }),
      );
      return undefined;
    });
    const run = await post(thread.id);
    await waitFor(() => status(run) === "waiting_continuation", 5000, "budget checkpoint");
    // The first call was in flight under the limit: forwarded and charged; the second refused.
    expect(statuses).toEqual([200, 402]);
    expect(countTokens).toBe(200);
    expect(forwarded).toBe(2);
    const record = h.app.deskmates.ctx.runs.mustGet(run);
    expect(record.resumePayload).toMatchObject({ sdkSessionId: "sess-1", budget: true });
    expect(record.error).toBeUndefined();
    const replies = h.app.deskmates.ctx.messages
      .list(thread.id, 0)
      .filter((m) => m.authorKind === "bot");
    expect(replies).toEqual([]);
    const [parked] = await budgets();
    expect(parked?.week.spend.totalUsd).toBe(3);
    expect(parked?.parks[0]).toMatchObject({ runId: run, checkpoint: "model_call", attempt: 1 });

    expect((await h.api("POST", `/api/budgets/${workspace.id}/continue`, {})).status).toBe(409);
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: 50 });
    await new Promise((r) => setTimeout(r, 50));
    expect(status(run)).toBe("waiting_continuation");
    expect((await h.api("POST", `/api/budgets/${workspace.id}/continue`, {})).status).toBe(200);
    await waitFor(() => status(run) === "succeeded", 5000, "resumed run");
    expect(triggers).toEqual(["thread_message", "budget_continuation"]);
    expect(h.app.deskmates.ctx.runs.mustGet(run).attempt).toBe(2);
  });

  it("fails a run the budget stopped with no session to resume", async () => {
    const { workspace, thread } = await h.seed();
    h.provider.onRun(callOnce([]));
    const first = await post(thread.id);
    await waitFor(() => status(first) === "succeeded", 5000, "first run");
    await h.app.deskmates.scheduler.drain();
    await h.api("PUT", `/api/budgets/${workspace.id}`, { cumulativeLimitUsd: 6 });
    h.provider.onRun(async (req, gw) => {
      // Under the ceiling at start; the first call brings spend to $6, the second is refused.
      for (let i = 0; i < 2; i++)
        await (await gw.model("/v1/messages", { model: MODEL, messages: [] })).text();
      await gw.post("ended", ended(req, { outcome: "failed", error: "API Error: 402" }));
      return undefined;
    });
    const run = await post(thread.id);
    await waitFor(() => status(run) === "failed", 5000, "unresumable");
    expect(h.app.deskmates.ctx.runs.mustGet(run).error).toBe("budget_exhausted");
  });

  it("lets Stop cancel parked work, which then leaves the parked list", async () => {
    const { workspace, thread } = await h.seed();
    h.provider.onRun(callOnce([]));
    const first = await post(thread.id);
    await waitFor(() => status(first) === "succeeded", 5000, "first run");
    await h.app.deskmates.scheduler.drain();
    await h.api("PUT", `/api/budgets/${workspace.id}`, { weeklyLimitUsd: 1 });
    const second = await post(thread.id);
    await waitFor(() => h.app.deskmates.ctx.budget.openPark(second) !== undefined, 5000, "park");
    expect((await h.api("POST", `/api/runs/${second}/cancel`, {})).status).toBe(200);
    expect(status(second)).toBe("cancelled");
    expect((await budgets())[0]?.parks).toEqual([]);
  });
});
