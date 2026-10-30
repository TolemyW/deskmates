// T0/T1 with the fake SDK and an in-memory Gateway (ADR-0035 decision 1): `app_publish` is offered
// only when the run carries it, posts to the run's own route with the run token, needs no
// approval (L1), and returns the URL, or the Gateway's refusal, to the model.

import type {
  BotId,
  RunEnded,
  RunId,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { riskTier } from "./risk-tier.js";
import { runOnce } from "./run-once.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const TOKEN = "deskmates-run-token-apps";
const HOME = "/home/nova";

function request(
  tools: StartRunRequest["tools"] = ["thread_post", "app_publish"],
): StartRunRequest {
  return {
    runId: "run-1" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    botRole: "ops bot",
    workspaceId: "ws-1" as WorkspaceId,
    workspaceName: "Ops",
    threadId: "thread-1" as ThreadId,
    botHomeDir: HOME,
    attempt: 1,
    trigger: {
      kind: "thread_message",
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Apps" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "Build me a todo app",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: TOKEN,
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: [],
    connectors: [],
    tools,
  };
}

function setup(steps: ScriptStep[], answer: { status: number; body: unknown }) {
  const sdk = createFakeSdk(steps);
  const gateway = createFakeGateway();
  const calls: { path: string; authorization: string | null; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (!path.endsWith("/app-shares")) return gateway.fetch(input, init);
    calls.push({
      path,
      authorization: new Headers(init?.headers).get("authorization"),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => new Date("2026-10-14T10:00:00Z"),
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  return { gateway, deps, calls };
}

const go = (deps: SidecarDeps, req: StartRunRequest): Promise<RunEnded> =>
  runOnce(req, deps, { approvalPollMs: 1, batchDelayMs: 1 });

const publishStep: ScriptStep = {
  type: "tool_call",
  name: "mcp__deskmates__app_publish",
  input: { port: 3000, label: "Todo app" },
};

const share = {
  id: "app_0123456789abcdef0123456789abcdef",
  workspaceId: "ws-1",
  port: 3000,
  label: "Todo app",
  url: "http://0123456789abcdef0123456789abcdef.apps.localhost:8790/",
  botId: "bot-nova",
  runId: "run-1",
  createdAt: "2026-10-14T10:00:00Z",
  revokedAt: null,
  revokedBy: null,
  state: "available",
};

describe("app_publish", () => {
  it("is offered only when the run carries it, and is an L1 write", async () => {
    const names: string[] = [];
    for (const req of [request(), request(["thread_post"])]) {
      const { deps } = setup([{ type: "end", summary: "" }], { status: 200, body: {} });
      const original = deps.createSdkMcpServer;
      deps.createSdkMcpServer = (options) => {
        names.push(...(options.tools ?? []).map((t) => t.name));
        return original(options);
      };
      await go(deps, req);
    }
    expect(names.filter((n) => n === "app_publish")).toHaveLength(1);
    expect(riskTier("mcp__deskmates__app_publish", {})).toBe("L1");
  });

  it("posts to the run's own route and returns the URL to post in chat", async () => {
    const { gateway, deps, calls } = setup([publishStep, { type: "end", summary: "" }], {
      status: 200,
      body: { share, existing: false },
    });
    await go(deps, request());
    expect(calls).toEqual([
      {
        path: "/internal/runs/run-1/app-shares",
        authorization: `Bearer ${TOKEN}`,
        body: { port: 3000, label: "Todo app" },
      },
    ]);
    expect(gateway.approvals).toEqual([]);
    const result = gateway.events.find((e) => e.kind === "tool_result");
    expect(result?.payload.isError).not.toBe(true);
    expect(String(result?.payload.content)).toContain(share.url);
  });

  it("tells the model when nothing answers yet, and hands a refusal back as text", async () => {
    const stopped = setup([publishStep, { type: "end", summary: "" }], {
      status: 200,
      body: { share: { ...share, state: "unavailable", reason: "not_running" }, existing: true },
    });
    await go(stopped.deps, request());
    const text = String(
      stopped.gateway.events.find((e) => e.kind === "tool_result")?.payload.content,
    );
    expect(text).toMatch(/Updated.*0\.0\.0\.0:3000/s);

    const refused = setup([publishStep, { type: "end", summary: "" }], {
      status: 409,
      body: {
        code: "invalid_transition",
        message: "app sharing is not configured on this Gateway",
      },
    });
    await go(refused.deps, request());
    const result = refused.gateway.events.find((e) => e.kind === "tool_result");
    expect(result?.payload.isError).toBe(true);
    expect(String(result?.payload.content)).toContain("not configured");
  });
});
