// T1 with the fake SDK and an in-memory Gateway (ADR-0051 decision 4): `bot_create`,
// `bot_update` and `group_create` are offered only when the run carries them, are L1 so they ask
// for no approval, call the run's own routes with the run token, and hand a refusal back to the
// model as text.

import {
  type BotId,
  DEFAULT_BOT_TOOL_NAMES,
  type RunEnded,
  type RunId,
  type StartRunRequest,
  type ThreadId,
  type WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { riskTier } from "./risk-tier.js";
import { runOnce } from "./run-once.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const TOKEN = "deskmates-run-token-assistant";
const HOME = "/home/assistant";

function request(
  tools: StartRunRequest["tools"] = ["thread_post", ...DEFAULT_BOT_TOOL_NAMES],
): StartRunRequest {
  return {
    runId: "run-1" as RunId,
    botId: "bot-assistant" as BotId,
    botName: "assistant",
    botRole: "Workspace assistant",
    workspaceId: "ws-1" as WorkspaceId,
    workspaceName: "Team",
    threadId: "thread-1" as ThreadId,
    botHomeDir: HOME,
    attempt: 1,
    trigger: {
      kind: "thread_message",
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Assistant" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "I need a daily AI news digest.",
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

interface Call {
  path: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

function setup(steps: ScriptStep[], answer: { status: number; body: unknown }) {
  const sdk = createFakeSdk(steps);
  const gateway = createFakeGateway();
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.includes("/assistant/")) return gateway.fetch(input, init);
    calls.push({
      path: url.pathname,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  };
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are the assistant." }),
    now: () => new Date("2026-10-19T10:00:00Z"),
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  return { gateway, deps, calls };
}

const go = (deps: SidecarDeps, req: StartRunRequest): Promise<RunEnded> =>
  runOnce(req, deps, { approvalPollMs: 1, batchDelayMs: 1 });

describe("default bot tools", () => {
  it("are offered only when the run carries them, and are L1", async () => {
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
    for (const name of DEFAULT_BOT_TOOL_NAMES) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
      expect(riskTier(`mcp__deskmates__${name}`, {})).toBe("L1");
    }
  });

  it("create, update and group through the run's own routes, asking for no approval", async () => {
    const steps: ScriptStep[] = [
      {
        type: "tool_call",
        name: "mcp__deskmates__bot_create",
        input: { name: "reporter", role: "Daily AI digest", soul: "You write a digest." },
      },
      {
        type: "tool_call",
        name: "mcp__deskmates__bot_update",
        input: {
          bot: "reporter",
          cron: [{ schedule: "0 8 * * *", prompt: "Write today's digest." }],
        },
      },
      {
        type: "tool_call",
        name: "mcp__deskmates__group_create",
        input: {
          bots: ["reporter"],
          title: "News",
          message: "Prepare the first digest.",
          startWith: ["reporter"],
        },
      },
      { type: "end", summary: "" },
    ];
    const { gateway, deps, calls } = setup(steps, {
      status: 200,
      body: {
        bot: { id: "bot-r", name: "reporter", role: "Daily AI digest", cron: [] },
        soulChanged: true,
        thread: { id: "thread-2", title: "News" },
        members: ["assistant", "reporter"],
      },
    });
    await go(deps, request());
    expect(calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/internal/runs/run-1/assistant/bots"],
      ["POST", "/internal/runs/run-1/assistant/bots/reporter"],
      ["POST", "/internal/runs/run-1/assistant/groups"],
    ]);
    expect(calls[0]?.body).toEqual({
      name: "reporter",
      role: "Daily AI digest",
      soul: "You write a digest.",
    });
    expect(calls[1]?.body).toEqual({
      cron: [{ schedule: "0 8 * * *", prompt: "Write today's digest." }],
    });
    expect(calls[2]?.body).toEqual({
      bots: ["reporter"],
      title: "News",
      message: "Prepare the first digest.",
      startWith: ["reporter"],
    });
    expect(calls.every((c) => c.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(gateway.approvals).toEqual([]);
    const results = gateway.events.filter((event) => event.kind === "tool_result");
    expect(String(results[0]?.payload.content)).toContain("bot ID: bot-r");
    expect(String(results[2]?.payload.content)).toContain("#/threads/thread-2");
  });

  it("hands a refusal back to the model as text", async () => {
    const { gateway, deps } = setup(
      [
        {
          type: "tool_call",
          name: "mcp__deskmates__bot_create",
          input: { name: "reporter", role: "" },
        },
        { type: "end", summary: "" },
      ],
      {
        status: 403,
        body: {
          code: "forbidden",
          message: "only a run of the workspace's default bot may create or change bots",
        },
      },
    );
    await go(deps, request());
    const result = gateway.events.find((e) => e.kind === "tool_result");
    expect(result?.payload.isError).toBe(true);
    expect(String(result?.payload.content)).toContain("forbidden");
  });
});
