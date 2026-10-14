// In-process operator API check, no listening socket, Docker or model.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { buildGateway } from "../../packages/gateway/src/index.js";
import { FakeProvider } from "../../packages/gateway/src/test-support/fake-provider.js";
import {
  TEST_OPERATOR_TOKEN,
  testConfig,
} from "../../packages/gateway/src/test-support/harness.js";
import type { Api } from "./client.js";
import { exportScenario, importScenario } from "./operations.js";
import { parseScenario } from "./schema.js";

it("round-trips a scenario through authenticated routes alongside canonical Bot chats", async () => {
  const app = buildGateway(testConfig(), new FakeProvider(), {
    surface: "combined-test",
    startCron: false,
  });
  const api: Api = {
    baseUrl: "http://in-process.test",
    async request<T>(method: string, path: string, body?: unknown): Promise<T> {
      const res = await app.inject({
        method: method as "GET" | "POST" | "PATCH",
        url: path,
        headers: {
          authorization: `Bearer ${TEST_OPERATOR_TOKEN}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
      expect(res.statusCode, `${method} ${path}: ${res.body}`).toBeLessThan(300);
      return res.json() as T;
    },
  };
  try {
    const scenario = parseScenario(
      JSON.parse(
        readFileSync(new URL("../../examples/scenarios/team-smoke.json", import.meta.url), "utf8"),
      ),
    );
    const first = await importScenario(api, scenario, async () => {});
    // List order follows created_at/id, not the scenario's declaration order.
    // Force the opposite thread order so this check cannot pass by timing luck.
    for (const [key, timestamp] of [
      ["solo", "2026-10-02T00:00:01.000Z"],
      ["team", "2026-10-02T00:00:00.000Z"],
    ] as const) {
      app.deskmates.ctx.db
        .prepare("UPDATE threads SET created_at = ? WHERE id = ?")
        .run(timestamp, first.threads[key]);
    }
    const exported = await exportScenario(api, first.workspaceId as string);
    expect([...exported.bots].sort((a, b) => a.name.localeCompare(b.name))).toEqual(
      scenario.bots
        .map((b) => ({ ...b, manualMemory: "" }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    const declaredThreads = exported.threads.filter((thread) =>
      scenario.threads.some((declared) => declared.title === thread.title),
    );
    // One-member declarations normalize to the Bot's canonical private chat; only groups retain
    // their independent title.
    expect(declaredThreads.map((t) => t.title)).toEqual(["Delegation smoke"]);
    // Compare each chat's content; member order remains part of the routing contract.
    const chats = (threads: typeof scenario.threads) =>
      threads
        .map(({ title, members }) => ({ title, members }))
        .sort((a, b) => a.title.localeCompare(b.title));
    expect(chats(declaredThreads)).toEqual(
      chats(scenario.threads.filter((t) => t.members.length > 1)),
    );
    const second = await importScenario(api, exported, async () => {});
    expect(second.workspaceId).not.toBe(first.workspaceId);
    expect(second.bots.chief).not.toBe(first.bots.chief);
    expect(app.deskmates.ctx.runs.list()).toHaveLength(4);
    expect(app.deskmates.ctx.runs.list().every((run) => run.triggerKind === "welcome")).toBe(true);
  } finally {
    await app.close();
  }
});
