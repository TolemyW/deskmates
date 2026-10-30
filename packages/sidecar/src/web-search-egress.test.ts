// T0 with the fake SDK and an in-memory Gateway (ADR-0049 decision 9): searching from a locked
// workspace is allowed, but opening a result on a host outside the list is still the ordinary
// egress approval of ADR-0020, and a private address stays denied without asking.

import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { runOnce } from "./run-once.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const HOME = "/home/nova";
const LOCKED = ["docs.example.org"];

function request(): StartRunRequest {
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
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Research" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "Find the supplier and open its page.",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-search-egress",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: LOCKED,
    connectors: [],
    tools: ["web_search"],
  };
}

const steps: ScriptStep[] = [
  { type: "tool_call", name: "mcp__deskmates__web_search", input: { query: "northwind supply" } },
  {
    type: "tool_call",
    name: "mcp__browser__browser_navigate",
    input: { url: "https://unlisted.example.com/about" },
    result: "never",
  },
  {
    type: "tool_call",
    name: "mcp__browser__browser_navigate",
    input: { url: "http://10.0.0.1/admin" },
    result: "never",
  },
  {
    type: "tool_call",
    name: "Bash",
    input: { command: "curl -s https://unlisted.example.com/about" },
    result: "never",
  },
  { type: "end", summary: "" },
];

describe("opening a search result in a locked workspace (decision 9)", () => {
  it("searches without asking, then asks for the unlisted host and denies the private one", async () => {
    const sdk = createFakeSdk(steps);
    // The default responder denies every approval, as an absent human would by timing out.
    const gateway = createFakeGateway({ egressAllowlist: () => LOCKED });
    const searches: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (new URL(String(input)).pathname.endsWith("/search")) {
        searches.push(String(init?.body));
        return new Response(
          JSON.stringify({
            searchId: "srch_1",
            results: [
              {
                title: "Northwind supply",
                url: "https://unlisted.example.com/about",
                snippet: "About Northwind",
                engine: "duckduckgo",
              },
            ],
            dropped: 0,
          }),
          { status: 200 },
        );
      }
      return gateway.fetch(input, init);
    };
    const deps: SidecarDeps = {
      query: sdk.query,
      tool: sdk.tool,
      createSdkMcpServer: sdk.createSdkMcpServer,
      fetch,
      fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
      now: () => new Date("2026-10-18T10:00:00Z"),
      env: { PATH: "/usr/bin" },
      sleep: async () => {},
    };
    await runOnce(request(), deps, { approvalPollMs: 1, batchDelayMs: 1 });
    const calls = [...sdk.sessions.values()][0]?.toolCalls ?? [];
    expect(searches).toHaveLength(1);
    expect(calls.map((c) => c.hookDecision)).toEqual(["allow", "deny", "deny", "deny"]);
    expect(calls[0]?.executed).toBe(true);
    // The search asked nobody; the unlisted host is an egress approval, for the browser and for
    // curl alike; the private address is denied outright and never asked for.
    expect(gateway.approvals.map((a) => [a.kind, a.action.targetOrigin])).toEqual([
      ["egress", "https://unlisted.example.com"],
      ["egress", "https://unlisted.example.com"],
    ]);
    expect(calls[2]?.hookReason).toContain("egress_blocked: 10.0.0.1");
  });
});
