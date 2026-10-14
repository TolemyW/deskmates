import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { workspaceNameProblem } from "../../packages/contracts/src/index.js";
import { type Api, createApi } from "./client.js";
import {
  type ImportReceipt,
  exportScenario,
  importScenario,
  runScenario,
  scenarioWorkspaceName,
} from "./operations.js";
import { fingerprint, parseScenario } from "./schema.js";

it("names an imported workspace inside the 32-unit bound (ADR-0034)", () => {
  const at = "2026-10-14T05:16:07.000Z";
  expect(scenarioWorkspaceName("team smoke", at)).toBe("team smoke #261014051607");
  const long = scenarioWorkspaceName("研究".repeat(20), at);
  expect(workspaceNameProblem(long)).toBeUndefined();
  expect(long.endsWith(" #261014051607")).toBe(true);
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing test fixture");
  return value;
}

const sample = () =>
  parseScenario(
    JSON.parse(
      readFileSync(new URL("../../examples/scenarios/team-smoke.json", import.meta.url), "utf8"),
    ),
  );

/** Fake operator transport; no server, Docker or model. Unknown routes fail the test. */
function fixture(outcome: "success" | "failed" | "blocked" | "timeout" | "unknown" = "success") {
  const calls: { method: string; path: string; body: Record<string, unknown> }[] = [];
  const bots: Record<string, unknown>[] = [];
  const threads: Record<string, unknown>[] = [];
  const files = new Map<string, { body: string; version: string }>();
  const messages: Record<string, unknown>[] = [];
  const runs: Record<string, unknown>[] = [];
  let time = 0;
  const api: Api = {
    baseUrl: "http://gateway.test",
    async request<T>(method: string, path: string, input?: unknown): Promise<T> {
      const body = (input ?? {}) as Record<string, unknown>;
      calls.push({ method, path, body });
      let result: unknown;
      const file = path.match(/^\/api\/bots\/(b\d+)\/(soul|memory)$/);
      if (path === "/api/config")
        result = {
          defaultModel: "test-model",
          cheapModel: "test-cheap",
          release: "test",
          cronTimeZone: "UTC",
        };
      else if (method === "POST" && path === "/api/workspaces")
        result = { workspace: { ...body, id: "w1" } };
      else if (method === "GET" && path === "/api/workspaces/w1")
        result = {
          workspace: { ...sample().workspace, id: "w1", status: "ready", secret: "never-export" },
          novncUrl: "never-export",
        };
      else if (method === "POST" && path === "/api/connectors")
        result = { connector: { id: "c1" } };
      else if (method === "POST" && path === "/api/bots") {
        const bot = { ...body, id: `b${bots.length + 1}`, soulVersion: 1, createdAt: "today" };
        bots.push(bot);
        result = { bot, webhookToken: "never-export" };
      } else if (path === "/api/bots?workspaceId=w1") result = { bots };
      else if (file) {
        const value = {
          body: method === "PATCH" ? (body.body as string) : (files.get(path)?.body ?? ""),
          version: "v1",
        };
        files.set(path, value);
        result = { [file[2] as string]: value };
      } else if (method === "POST" && path === "/api/threads") {
        const thread = { ...body, id: `t${threads.length + 1}`, kind: "chat" };
        threads.push(thread);
        result = { thread };
      } else if (path === "/api/threads?workspaceId=w1") result = { threads };
      else if (/^\/api\/threads\/t\d+$/.test(path)) {
        const thread = threads.find((t) => path.endsWith(`/${t.id}`));
        result = { thread, members: (thread?.botIds as string[]).map((botId) => ({ botId })) };
      } else if (path.startsWith("/api/runs?botId=")) {
        const botId = new URLSearchParams(path.split("?")[1]).get("botId");
        result = { runs: runs.filter((r) => r.botId === botId) };
      } else if (path.startsWith("/api/runs/")) {
        const run = runs.find((r) => r.id === path.split("?")[0]?.split("/")[3]);
        result = path.split("?")[0]?.endsWith("/events")
          ? { events: [], hasMore: false }
          : { run, usage: [] };
      } else if (path.includes("/messages")) {
        const threadId = path.split("/")[3];
        if (method === "POST") {
          if (outcome === "unknown") throw new Error("Transport failed; outcome unknown");
          const message = {
            id: `m${messages.length}`,
            seq: messages.length + 1,
            threadId,
            authorKind: "human",
            body: body.body,
          };
          messages.push(message);
          result = { message };
          runs.push({
            id: `r${runs.length}`,
            botId: "b1",
            threadId,
            status:
              outcome === "success"
                ? "succeeded"
                : outcome === "blocked"
                  ? "waiting_approval"
                  : outcome === "timeout"
                    ? "running"
                    : "failed",
            attempt: 1,
            config: { maxTurns: 8 },
          });
          messages.push({
            id: `m${messages.length}`,
            seq: messages.length + 1,
            threadId,
            authorId: "b1",
            authorKind: "bot",
            body: threadId === "t1" ? "SINGLE_OK" : "TEAM_TOTAL=42",
          });
        } else {
          const after = Number(new URL(path, api.baseUrl).searchParams.get("afterSeq") ?? 0);
          result = {
            messages: messages.filter((m) => m.threadId === threadId && Number(m.seq) > after),
          };
        }
      } else throw new Error(`Unhandled route: ${method} ${path}`);
      return structuredClone(result) as T;
    },
  };
  return {
    api,
    calls,
    bots,
    threads,
    files,
    messages,
    runs,
    clock: {
      now: () => time,
      sleep: async (ms: number) => {
        time += ms;
      },
    },
  };
}

describe("scenario validation", () => {
  it("accepts the example and rejects unknown fields, bad references and unbounded waits", () => {
    const s = sample();
    expect(parseScenario(s)).toEqual(s);
    expect(() => parseScenario({ ...s, token: "secret" })).toThrow("Unknown field");
    required(s.tasks[0]).thread = "missing";
    expect(() => parseScenario(s)).toThrow("Unknown task thread");
    const t = sample();
    required(t.tasks[0]).timeoutSeconds = 0;
    expect(() => parseScenario(t)).toThrow("timeout");
    const b = sample();
    required(b.bots[1]).name = "CHIEF";
    expect(() => parseScenario(b)).toThrow("Duplicate");
  });
  it("hashes independent of property order", () =>
    expect(fingerprint({ b: 2, a: 1 })).toBe(fingerprint({ a: 1, b: 2 })));
});

describe("portable import and export", () => {
  it("creates new IDs, preserves member order and reasoning, installs canonical files, disables cron and never submits a task", async () => {
    const f = fixture();
    const s = sample();
    required(s.bots[0]).cron = [{ schedule: "* * * * *", prompt: "do work" }];
    const snapshots: ImportReceipt[] = [];
    const receipt = await importScenario(f.api, s, async (r) => {
      snapshots.push(structuredClone(r));
    });
    expect(receipt.state).toBe("imported");
    expect(receipt.bots.chief).toBe("b1");
    expect(f.bots[0]).toMatchObject({ cron: [], effort: "high", thinking: { type: "adaptive" } });
    expect(f.threads[1]?.botIds).toEqual(["b1", "b2"]);
    expect(f.files.get("/api/bots/b1/soul")?.body).toBe(s.bots[0]?.soul);
    expect(f.calls.some((c) => c.path.includes("messages"))).toBe(false);
    expect(JSON.stringify(snapshots)).not.toContain("never-export");
    const exported = await exportScenario(f.api, "w1");
    expect(exported.bots[0]?.soul).toBe(s.bots[0]?.soul);
    expect(exported.threads[1]?.members).toEqual(["chief", "analyst"]);
    expect(exported.tasks).toEqual([]);
    expect(JSON.stringify(exported)).not.toMatch(/never-export|webhookToken|soulVersion/);
    const g = fixture();
    await importScenario(g.api, exported, async () => {});
    expect(g.bots).toHaveLength(2);
  });
  it("fails missing connector bindings before writing any object", async () => {
    const f = fixture();
    const s = sample();
    required(s.bots[0]).connectors = ["database"];
    await expect(importScenario(f.api, s, async () => {})).rejects.toThrow(
      "Missing local connector",
    );
    expect(f.calls).toHaveLength(0);
  });
  it("journals partial IDs when import fails without retrying", async () => {
    const f = fixture();
    const request = f.api.request;
    let last: ImportReceipt | undefined;
    f.api.request = async (method, path, body) => {
      if (method === "PATCH") throw new Error("HTTP 409");
      return request(method, path, body);
    };
    await expect(
      importScenario(f.api, sample(), async (r) => {
        last = structuredClone(r);
      }),
    ).rejects.toThrow("409");
    expect(last).toMatchObject({ state: "failed", workspaceId: "w1", bots: { chief: "b1" } });
    expect(f.bots).toHaveLength(1);
  });
});

describe("explicit one-shot execution", () => {
  for (const outcome of ["success", "failed", "blocked", "timeout", "unknown"] as const) {
    it(`records ${outcome} and stops subsequent tasks unless passed`, async () => {
      const f = fixture(outcome);
      const s = sample();
      required(s.tasks[0]).timeoutSeconds = 3;
      const receipt = await importScenario(f.api, s, async () => {});
      const report = await runScenario(
        f.api,
        s,
        receipt,
        async () => {},
        async () => {},
        f.clock,
      );
      expect(report.tasks[0]?.status).toBe(outcome === "success" ? "passed" : outcome);
      expect(report.tasks).toHaveLength(outcome === "success" ? 2 : 1);
      if (outcome === "success") expect(report.tasks[0]?.runs?.[0]?.usage).toBeNull();
      const submissions = f.calls.filter(
        (c) => c.method === "POST" && c.path.endsWith("/messages"),
      ).length;
      await expect(
        runScenario(
          f.api,
          s,
          receipt,
          async () => {},
          async () => {},
          f.clock,
        ),
      ).rejects.toThrow("never-executed");
      expect(
        f.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages")),
      ).toHaveLength(submissions);
    });
  }
  it("rejects changed content or target before posting", async () => {
    const f = fixture();
    const s = sample();
    const r = await importScenario(f.api, s, async () => {});
    required(s.tasks[0]).message += " changed";
    await expect(
      runScenario(
        f.api,
        s,
        r,
        async () => {},
        async () => {},
        f.clock,
      ),
    ).rejects.toThrow("hash");
    expect(f.messages).toHaveLength(0);
  });
  it("does not accept an earlier bot answer as the new task's result", async () => {
    const f = fixture();
    const s = sample();
    required(required(s.tasks[0]).expectReply).contains = "OLD_OK";
    const r = await importScenario(f.api, s, async () => {});
    f.messages.push({
      id: "old",
      seq: 1,
      threadId: "t1",
      authorKind: "bot",
      authorId: "b1",
      body: "OLD_OK",
    });
    const report = await runScenario(
      f.api,
      s,
      r,
      async () => {},
      async () => {},
      f.clock,
    );
    expect(report.tasks[0]?.status).toBe("failed");
  });

  it.each([
    { authorKind: "human", authorId: "b1" },
    { authorKind: "system", authorId: "b1" },
    { authorKind: "bot", authorId: "b2" },
  ])("rejects a new marker from the wrong author: %j", async (author) => {
    const f = fixture();
    const s = sample();
    const request = f.api.request;
    f.api.request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
      const response = await request<T>(method, path, body);
      if (method === "POST" && path.endsWith("/messages")) {
        Object.assign(required(f.messages.at(-1)), author);
      }
      return response;
    };
    const receipt = await importScenario(f.api, s, async () => {});
    const report = await runScenario(
      f.api,
      s,
      receipt,
      async () => {},
      async () => {},
      f.clock,
    );
    expect(report.tasks[0]?.status).toBe("failed");
    expect(report.tasks).toHaveLength(1);
    expect(
      f.calls.filter((call) => call.method === "POST" && call.path.endsWith("/messages")),
    ).toHaveLength(1);
  });

  it("keeps a successful run without a reply oracle explicitly unchecked", async () => {
    const f = fixture();
    const s = sample();
    s.tasks = s.tasks.slice(0, 1);
    const { expectReply: _oracle, ...task } = required(s.tasks[0]);
    s.tasks = [task];
    const receipt = await importScenario(f.api, s, async () => {});
    const report = await runScenario(
      f.api,
      s,
      receipt,
      async () => {},
      async () => {},
      f.clock,
    );
    expect(report.tasks[0]?.status).toBe("completed-unchecked");
  });
});

it("never follows redirects or prints credential-bearing HTTP bodies", async () => {
  const api = createApi("http://localhost:3000", "secret-token", async (_url, init) => {
    expect(init?.redirect).toBe("error");
    return new Response("secret-token: rejected", { status: 401 });
  });
  await expect(api.request("GET", "/api/config")).rejects.toThrow("HTTP 401");
});
