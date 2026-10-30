import { type RunId, buildRunTimeline } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { type OperatorReader, observeDeployment, workspaceRunIds } from "./observer.js";

const at = "2026-10-19T00:00:00.000Z";
function reader(responses: Record<string, unknown>, calls: string[]): OperatorReader {
  return {
    api: async <T>(method: string, path: string) => {
      calls.push(`${method} ${path}`);
      if (method !== "GET") throw new Error("unexpected mutation");
      if (!(path in responses)) return { status: 404, json: {} as T };
      return { status: 200, json: responses[path] as T };
    },
  };
}

describe("long-horizon deployment observer", () => {
  it("reads every run page and event tail, retaining a failed observation separately", async () => {
    const calls: string[] = [];
    const events = [1, 2].map((seq) => ({
      runId: "run_ok" as RunId,
      seq,
      kind: "log",
      ts: at,
      payload: { text: `line ${seq}` },
    }));
    const api = reader(
      {
        "/api/runs?workspaceId=ws_test&limit=100": {
          runs: [{ id: "run_ok" }],
          nextCursor: "page2",
        },
        "/api/runs?workspaceId=ws_test&limit=100&cursor=page2": {
          runs: [{ id: "run_failed_read" }],
        },
        "/api/runs/run_ok": {
          run: {
            id: "run_ok",
            status: "cancelled",
            attempt: 1,
            config: { maxTurns: 50 },
            threadId: "thread_test",
          },
          usage: [],
          usageCoverage: "not_started",
        },
        "/api/runs/run_ok/timeline": buildRunTimeline({
          runId: "run_ok",
          status: "cancelled",
          attempt: 1,
          createdAt: at,
          finishedAt: at,
          events: [],
        }),
        "/api/runs/run_ok/context": {
          turns: 0,
          compactions: [],
          peakInputTokens: null,
          cacheHitRatio: null,
        },
        "/api/runs/run_ok/events?afterSeq=0": { events: [events[0]], hasMore: true },
        "/api/runs/run_ok/events?afterSeq=1": { events: [events[1]] },
        "/api/threads/thread_test/messages?afterSeq=0": {
          messages: [{ seq: 1, authorKind: "bot", runId: "another", body: "ignore" }],
          hasMore: true,
        },
        "/api/threads/thread_test/messages?afterSeq=1": {
          messages: [{ seq: 2, authorKind: "bot", runId: "run_ok", body: "answer: 6" }],
        },
      },
      calls,
    );
    const report = await observeDeployment(api, "ws_test");
    expect(report.runs).toHaveLength(1);
    expect(report.runs[0]).toMatchObject({
      reply: "answer: 6",
      recordedConfig: { maxTurns: 50 },
      ledgerContiguous: true,
    });
    expect(report.runs[0]?.events).toHaveLength(2);
    expect(report.errors).toEqual([
      { runId: "run_failed_read", error: "Error: observer GET failed: 404" },
    ]);
    expect(calls.every((c) => c.startsWith("GET /api/"))).toBe(true);
  });
  it("stops a repeated cursor instead of silently accepting an incomplete run inventory", async () => {
    const api = reader(
      {
        "/api/runs?workspaceId=ws_test&limit=100": { runs: [], nextCursor: "same" },
        "/api/runs?workspaceId=ws_test&limit=100&cursor=same": { runs: [], nextCursor: "same" },
      },
      [],
    );
    await expect(workspaceRunIds(api, "ws_test")).rejects.toThrow("no progress");
  });
  it("keeps a discovered background id when a later inventory page fails", async () => {
    const api = reader(
      {
        "/api/runs?workspaceId=ws_test&limit=100": {
          runs: [{ id: "run_background" }],
          nextCursor: "page2",
        },
      },
      [],
    );
    const observed = await observeDeployment(api, "ws_test");
    expect(observed.inventoryComplete).toBe(false);
    expect(observed.inventoryError).toContain("observer GET failed: 404");
    expect(observed.errors).toEqual([
      { runId: "run_background", error: "Error: observer GET failed: 404" },
    ]);
  });
  it("reports a wholly unavailable inventory explicitly instead of an empty complete list", async () => {
    const observed = await observeDeployment(reader({}, []), "ws_test");
    expect(observed).toMatchObject({ runs: [], errors: [], inventoryComplete: false });
    expect(observed.inventoryError).toContain("observer GET failed: 404");
  });
});
