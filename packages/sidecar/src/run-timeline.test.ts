// T1: the sidecar's startup timeline marks (ADR-0037 decision 1) from fake SDK messages: process
// start, query start, SDK init with MCP status, first stream event, first token, first text and
// the SDK's own result numbers, each once and only for the top-level conversation.

import type {
  BotId,
  RunId,
  SidecarEvent,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { runOnce } from "./run-once.js";
import { SidecarTimeline, processStartedAt } from "./run-timeline.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const HOME = "/home/nova";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-timeline" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    workspaceId: "ws-1" as WorkspaceId,
    threadId: "thread-1" as ThreadId,
    botHomeDir: HOME,
    attempt: 1,
    trigger: {
      kind: "thread_message",
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Ops" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "hi",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test",
    modelAuthToken: "deskmates-run-token-timeline-0a1b",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: [],
    connectors: [],
    tools: ["thread_post"],
    ...overrides,
  };
}

const summary = (reply: string) =>
  `\`\`\`json\n${JSON.stringify({
    done: reply,
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    learned: [],
    reply,
  })}\n\`\`\``;

async function play(script: ScriptStep[], overrides: Partial<StartRunRequest> = {}) {
  const sdk = createFakeSdk(script);
  const gateway = createFakeGateway({ egressAllowlist: () => [] });
  let clock = Date.parse("2026-10-14T10:00:00Z");
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: gateway.fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => {
      clock += 100;
      return new Date(clock);
    },
    uptimeSeconds: () => 2,
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  const ended = await runOnce(request(overrides), deps, { approvalPollMs: 1, batchDelayMs: 1 });
  const marks = gateway.events
    .filter((e: SidecarEvent) => e.kind === "log" && e.payload.source === "run_timeline")
    .map((e) => e.payload);
  return { ended, marks };
}

describe("sidecar timeline marks", () => {
  it("records each stage once, in order, for a streamed reply", async () => {
    const { ended, marks } = await play([
      { type: "streamed_text", chunks: ["", "Hel", "lo"] },
      { type: "streamed_text", chunks: ["again"] },
      { type: "end", summary: summary("Hello") },
    ]);
    expect(ended.outcome).toBe("completed");
    expect(marks.map((m) => m.mark)).toEqual([
      "sidecar_started",
      "query_started",
      "sdk_init",
      "first_stream_event",
      "first_token",
      "first_text",
      "sdk_result",
    ]);
    const byName = new Map(marks.map((m) => [m.mark, m]));
    // Uptime of 2 s before the first clock reading.
    expect(byName.get("sidecar_started")?.processStartedAt).toBe("2026-10-14T09:59:58.100Z");
    expect(byName.get("query_started")?.resume).toBe(false);
    expect(byName.get("sdk_init")?.mcpServers).toEqual(
      expect.arrayContaining([{ name: "deskmates", status: "connected" }]),
    );
    // The empty first chunk is a token but not text.
    expect(Date.parse(String(byName.get("first_text")?.at))).toBeGreaterThan(
      Date.parse(String(byName.get("first_token")?.at)),
    );
    expect(byName.get("sdk_result")).toMatchObject({ subtype: "success", numTurns: 2 });
    for (const m of marks) expect(m).toMatchObject({ source: "run_timeline", version: 1 });
  });

  it("leaves stream marks out when the SDK sent no partial messages", async () => {
    const { marks } = await play([
      { type: "text", text: "plain" },
      { type: "end", summary: summary("plain") },
    ]);
    expect(marks.map((m) => m.mark)).toEqual([
      "sidecar_started",
      "query_started",
      "sdk_init",
      "sdk_result",
    ]);
  });

  it("marks a resumed session and still records the SDK's error result", async () => {
    const { ended, marks } = await play(
      [
        { type: "api_retry", attempt: 1, errorStatus: 529 },
        { type: "fail", errors: ["boom"] },
      ],
      { sdkSessionId: "sess-1" },
    );
    expect(ended.outcome).toBe("failed");
    expect(marks.find((m) => m.mark === "query_started")?.resume).toBe(true);
    expect(marks.find((m) => m.mark === "sdk_result")?.subtype).toBe("error_during_execution");
  });
});

describe("SidecarTimeline", () => {
  it("ignores subagent streams and survives a failing recorder", () => {
    const seen: Record<string, unknown>[] = [];
    const timeline = new SidecarTimeline(
      (payload) => seen.push(payload),
      () => new Date(0),
    );
    timeline.observe({
      type: "stream_event",
      event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } },
      parent_tool_use_id: "toolu_sub",
      uuid: "00000000-0000-0000-0000-000000000000",
      session_id: "s",
    });
    expect(seen).toEqual([]);
    const failing = new SidecarTimeline(
      () => {
        throw new Error("ledger down");
      },
      () => new Date(0),
    );
    expect(() => failing.mark("query_started")).not.toThrow();
  });

  it("computes the process start from uptime", () => {
    expect(processStartedAt(new Date(10_000), 4).toISOString()).toBe("1970-01-01T00:00:06.000Z");
  });
});
