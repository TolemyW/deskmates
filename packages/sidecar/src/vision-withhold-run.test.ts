// T1, ADR-0023 amendment 2, decisions 12 and 13 (issue #87), through `runOnce` with the fake SDK:
// a withholding run's prompt says the model cannot see, its image `Read` is denied with a notice
// the model reads instead of an image block, the ledger records the withholding, and the browser
// MCP server is started blind. A delivering run is exactly as before.

import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { BROWSER_MCP_SERVER } from "./risk-tier.js";
import { runOnce } from "./run-once.js";
import { systemPromptText } from "./system-prompt.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";
import { VISION_POLICY_ENV, VISION_WITHHELD_GUIDANCE } from "./vision-withhold.js";

const HOME = "/home/nova";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-vision" as RunId,
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
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Deck" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "Review /work/slide-1.png for overflow",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-vision-1234",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 20,
    egressAllowlist: [],
    connectors: [],
    tools: ["thread_post"],
    ...overrides,
  };
}

const final = `\`\`\`json\n${JSON.stringify({ done: "reviewed", reply: "done" })}\n\`\`\``;

const script: ScriptStep[] = [
  {
    type: "tool_call",
    name: "Read",
    input: { file_path: "/work/slide-1.PNG" },
    result: "[image bytes the model would have been handed]",
  },
  {
    type: "tool_call",
    name: "Read",
    input: { file_path: "/work/notes.md" },
    result: "Slide notes",
  },
  // ADR-0023 amendment 3, decision 15: a PDF's pages reach the model as images.
  {
    type: "tool_call",
    name: "Read",
    input: { file_path: "/work/deck.PDF" },
    result: "[pdf pages the model would have been handed]",
  },
  { type: "text", text: final },
  { type: "end", summary: final },
];

async function run(req: StartRunRequest) {
  const sdk = createFakeSdk(script);
  const gateway = createFakeGateway({ egressAllowlist: () => req.egressAllowlist });
  let clock = Date.parse("2026-10-14T10:00:00Z");
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: gateway.fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  const ended = await runOnce(req, deps, { approvalPollMs: 1, batchDelayMs: 1 });
  const [session] = [...sdk.sessions.values()];
  const options = session?.calls[0]?.options as {
    systemPrompt?: unknown;
    mcpServers?: Record<string, { args?: string[]; env?: Record<string, string> }>;
  };
  const results = gateway.events
    .filter((e) => e.kind === "tool_result")
    .map((e) => e.payload as { text?: string; isError?: boolean });
  const withheld = gateway.events.filter(
    (e) => e.kind === "log" && e.payload.source === "vision" && e.payload.op === "image_withheld",
  );
  return { ended, options, results, withheld };
}

describe("a run whose model cannot see (visionPolicy: withhold)", () => {
  it("denies the image Read with a notice, records it, and leaves text reads alone", async () => {
    const { ended, options, results, withheld } = await run(request({ visionPolicy: "withhold" }));
    expect(ended.outcome).toBe("completed");
    expect(JSON.stringify(results[0])).toContain("image_withheld: /work/slide-1.PNG");
    expect(JSON.stringify(results[0])).not.toContain("image bytes");
    expect(JSON.stringify(results[1])).toContain("Slide notes");
    expect(JSON.stringify(results[2])).toContain("image_withheld: /work/deck.PDF is a PDF");
    expect(JSON.stringify(results[2])).not.toContain("pdf pages");
    expect(withheld).toHaveLength(2);
    expect(withheld[0]?.payload).toMatchObject({ toolName: "Read", path: "/work/slide-1.PNG" });
    expect(withheld[0]?.payload.toolUseId).toEqual(expect.any(String));
    expect(withheld[1]?.payload).toMatchObject({
      toolName: "Read",
      path: "/work/deck.PDF",
      media: "application/pdf",
    });
    expect(systemPromptText(options.systemPrompt)).toContain(VISION_WITHHELD_GUIDANCE);
    const browser = options.mcpServers?.[BROWSER_MCP_SERVER];
    expect(browser?.args).not.toContain("vision");
    expect(browser?.env?.[VISION_POLICY_ENV]).toBe("withhold");
  });
});

describe("a run that delivers images (no policy key)", () => {
  it("is unchanged: the image Read runs, no notice, no prompt section, the browser can see", async () => {
    const { results, withheld, options } = await run(request());
    expect(JSON.stringify(results[0])).toContain("image bytes");
    expect(JSON.stringify(results[2])).toContain("pdf pages");
    expect(withheld).toHaveLength(0);
    expect(systemPromptText(options.systemPrompt)).not.toContain("## Images");
    const browser = options.mcpServers?.[BROWSER_MCP_SERVER];
    expect(browser?.args).toContain("vision");
    expect(browser?.env?.[VISION_POLICY_ENV]).toBeUndefined();
  });
});
