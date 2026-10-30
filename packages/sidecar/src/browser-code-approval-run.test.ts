// T1, ADR-0002 amendment 5, C4 and C5 (issue #78), through `runOnce` with the fake SDK: under the
// opt-in `effects-v1` policy a run-code upload posts one approval whose action names the effect
// and binds to the code's hash, a denial reaches the model and the call never runs; passive code
// runs unasked; and under the default (no key) the same upload runs unasked as before.

import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { runOnce } from "./run-once.js";
import { parseStartRunRequest } from "./start-run-request.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const HOME = "/home/nova";
const UPLOAD = "async (page) => { await page.setInputFiles('#file', '/work/synthetic.txt'); }";
const PASSIVE = "async (page) => page.locator('h1').innerText()";
const RAN = "[code ran in the page]";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-code" as RunId,
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
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Uploads" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "Attach the synthetic file to the form",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-code-1234",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 20,
    egressAllowlist: [],
    connectors: [],
    tools: ["thread_post"],
    ...overrides,
  };
}

const final = `\`\`\`json\n${JSON.stringify({ done: "tried", reply: "done" })}\n\`\`\``;

function script(code: string): ScriptStep[] {
  return [
    {
      type: "tool_call",
      name: "mcp__browser__browser_run_code_unsafe",
      input: { code },
      result: RAN,
    },
    { type: "text", text: final },
    { type: "end", summary: final },
  ];
}

async function run(req: StartRunRequest, code: string) {
  const sdk = createFakeSdk(script(code));
  const gateway = createFakeGateway({
    egressAllowlist: () => req.egressAllowlist,
    approvalResponder: (approval) => ({
      type: "approval_response",
      approvalId: approval.approvalId,
      decision: "deny",
    }),
  });
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
  const call = gateway.events.find((e) => e.kind === "tool_call");
  const result = gateway.events.find((e) => e.kind === "tool_result");
  return { ended, gateway, call, result: JSON.stringify(result?.payload) };
}

describe("browser code under effects-v1", () => {
  it("asks once for a run-code upload, shows the effect, and a denial means it never ran", async () => {
    const { ended, gateway, call, result } = await run(
      request({ browserCodeApproval: "effects-v1" }),
      UPLOAD,
    );
    expect(ended.outcome).toBe("completed");
    expect(gateway.approvals).toHaveLength(1);
    const action = gateway.approvals[0]?.action;
    expect(gateway.approvals[0]?.riskLevel).toBe("L2");
    expect(action?.toolName).toBe("mcp__browser__browser_run_code_unsafe");
    expect(action?.argumentSummary).toMatch(/^page code: upload sha256:[0-9a-f]{64}$/);
    expect(action?.argumentPattern).toMatch(/^\* sha256:[0-9a-f]{64}$/);
    expect(call?.payload.riskLevel).toBe("L2");
    expect(result).not.toContain(RAN);
  });

  it("runs passive code unasked", async () => {
    const { gateway, call, result } = await run(
      request({ browserCodeApproval: "effects-v1" }),
      PASSIVE,
    );
    expect(gateway.approvals).toHaveLength(0);
    expect(call?.payload.riskLevel).toBe("L1");
    expect(result).toContain(RAN);
  });
});

describe("browser code under the default name-v1 (no key)", () => {
  it("runs the same upload unasked, as before the amendment", async () => {
    const { gateway, call, result } = await run(request(), UPLOAD);
    expect(gateway.approvals).toHaveLength(0);
    expect(call?.payload.riskLevel).toBe("L1");
    expect(result).toContain(RAN);
  });
});

describe("the start request carries the policy through stdin", () => {
  const raw = (value: unknown) => JSON.stringify({ ...request(), browserCodeApproval: value });

  it("accepts effects-v1 and absence, and refuses anything else", () => {
    const parsed = parseStartRunRequest(raw("effects-v1"));
    expect(parsed.ok && parsed.value.browserCodeApproval).toBe("effects-v1");
    expect(parseStartRunRequest(JSON.stringify(request())).ok).toBe(true);
    expect(parseStartRunRequest(raw("name-v1")).ok).toBe(false);
    expect(parseStartRunRequest(raw("all")).ok).toBe(false);
  });
});
