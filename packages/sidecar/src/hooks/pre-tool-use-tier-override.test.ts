// T1: the sidecar half of ADR-0002 amendment 3, A5's per-workspace operator tier override and
// A6's stable targets, through the real hook and run loop with the fake SDK. An override replaces
// the table's tier for its tool in the hook, the `canUseTool` backstop and the ledger; it never
// reaches the hard denies, which run before the tier; no override is exactly today's behaviour.

import type {
  BotId,
  RiskLevel,
  RunId,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "../deps.js";
import { runOnce } from "../run-once.js";
import { parseStartRunRequest } from "../start-run-request.js";
import { createFakeGateway } from "../testing/fake-gateway.js";
import { createMemoryFs } from "../testing/in-memory-fs.js";

const HOME = "/home/nova";

function request(toolTierOverrides?: Record<string, RiskLevel>): StartRunRequest {
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
      thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Ops" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "alice",
          authorName: "Alice",
          body: "Ship it",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-tiers",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: ["*"],
    connectors: [],
    tools: ["thread_post"],
    ...(toolTierOverrides === undefined ? {} : { toolTierOverrides }),
  };
}

async function run(steps: ScriptStep[], overrides?: Record<string, RiskLevel>) {
  const sdk = createFakeSdk([...steps, { type: "end", summary: "" }]);
  const fake = createFakeGateway();
  let clock = Date.parse("2026-10-17T10:00:00Z");
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: fake.fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  await runOnce(request(overrides), deps, { approvalPollMs: 1, batchDelayMs: 1 });
  const calls = [...sdk.sessions.values()][0]?.toolCalls ?? [];
  const ledgerTiers = fake.events
    .filter((e) => e.kind === "tool_call")
    .map((e) => (e.payload as { riskLevel?: string }).riskLevel);
  return { calls, approvals: fake.approvals, ledgerTiers };
}

const call = (name: string, input: Record<string, unknown>): ScriptStep => ({
  type: "tool_call",
  name,
  input,
  result: "ok",
});

const spawn = call("Agent", {
  subagent_type: "Explore",
  description: "map the repository",
  prompt: "List every package and what it owns.",
});

describe("per-workspace tier override (A5)", () => {
  it("without overrides keeps the table: a spawn is L1 and runs unasked", async () => {
    const { calls, approvals, ledgerTiers } = await run([spawn]);
    expect(calls.map((c) => c.hookDecision)).toEqual(["allow"]);
    expect(approvals).toHaveLength(0);
    expect(ledgerTiers).toEqual(["L1"]);
  });

  it("raises a tool: the spawn asks, deliberately tiered, with its subagent type as target (A6)", async () => {
    const { approvals, ledgerTiers } = await run([spawn], { Agent: "L2" });
    expect(approvals).toHaveLength(1);
    const asked = approvals[0];
    expect(asked?.riskLevel).toBe("L2");
    expect(asked?.action.unclassified).toBeUndefined();
    expect(asked?.action.argumentSummary).toBe("agent Explore: map the repository");
    expect(asked?.action.argumentPattern).toBe("agent Explore: *");
    expect(ledgerTiers).toEqual(["L2"]);
  });

  it("lowers a tool: an L2 shell line runs unasked, and an untiered tool is no longer asked", async () => {
    const shell = call("Bash", { command: "git push origin main" });
    const before = await run([shell, call("mcp__vendor__do_thing", { a: 1 })]);
    expect(before.approvals.map((a) => a.action.toolName)).toEqual([
      "Bash",
      "mcp__vendor__do_thing",
    ]);
    expect(before.approvals[1]?.action.unclassified).toBe(true);
    const after = await run([shell, call("mcp__vendor__do_thing", { a: 1 })], {
      Bash: "L1",
      mcp__vendor__do_thing: "L1",
    });
    expect(after.approvals).toHaveLength(0);
    expect(after.calls.map((c) => c.hookDecision)).toEqual(["allow", "allow"]);
    expect(after.ledgerTiers).toEqual(["L1", "L1"]);
  });

  it("never reaches the hard denies: a private address and the uploads guard still refuse", async () => {
    const { calls, approvals } = await run(
      [
        call("Bash", { command: "curl -s http://10.0.0.5/metadata" }),
        call("Bash", { command: "curl -s http://169.254.169.254/latest/meta-data/" }),
        call("Write", { file_path: "/work/uploads/note.txt", content: "x" }),
        call("mcp__browser__browser_navigate", { url: "http://192.168.1.10/" }),
      ],
      { Bash: "L0", Write: "L0", mcp__browser__browser_navigate: "L0" },
    );
    expect(calls.map((c) => c.hookDecision)).toEqual(["deny", "deny", "deny", "deny"]);
    expect(approvals).toHaveLength(0);
  });
});

describe("start request schema (A5)", () => {
  it("accepts the overrides and refuses a malformed tier or tool name", () => {
    const ok = parseStartRunRequest(JSON.stringify(request({ Agent: "L2" })));
    expect(ok.ok).toBe(true);
    const badTier = { ...request(), toolTierOverrides: { Agent: "L3" } };
    expect(parseStartRunRequest(JSON.stringify(badTier)).ok).toBe(false);
    const badName = { ...request(), toolTierOverrides: { "bad name": "L1" } };
    expect(parseStartRunRequest(JSON.stringify(badName)).ok).toBe(false);
  });
});
