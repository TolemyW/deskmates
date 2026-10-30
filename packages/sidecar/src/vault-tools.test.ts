// T1 (ADR-0045 decisions 4, 5 and 7), through the real hook and run loop with the fake SDK and a
// fake Gateway: `vault_list` is L0 and runs unasked; a release is L2 under any tier override and
// its action is the entry's, bound to `vault:<id> rev:<n> op:<operation>` on the exact origin; a
// fill on a tab of another origin, a stale revision or a human-held browser is refused before
// anyone is asked; the approval the hook allowed is the one the handler names to the Gateway,
// and a handler with no allowed release asks nothing of it. The ledger and the model see
// references only, and a fill marks the tab for capture suppression.

import type {
  ApprovalRequest,
  BotId,
  RiskLevel,
  RunId,
  StartRunRequest,
  ThreadId,
  VaultUseResult,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import { browserStatePath } from "./browser-state.js";
import type { SidecarDeps } from "./deps.js";
import { runOnce } from "./run-once.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";
import { vaultCapturePath } from "./vault-capture.js";
import { vaultCallKey } from "./vault-release.js";

const HOME = "/home/nova";
const RUN = "run-1" as RunId;
const ORIGIN = "https://console.example.test";
const SECRET = "synthetic-sidecar-password-77c0";

function request(toolTierOverrides?: Record<string, RiskLevel>): StartRunRequest {
  return {
    runId: RUN,
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
          body: "Sign in to the console",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-vault",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: ["*"],
    connectors: [],
    tools: ["thread_post", "vault_list", "vault_fill", "vault_request"],
    ...(toolTierOverrides === undefined ? {} : { toolTierOverrides }),
  };
}

interface Options {
  tabUrl?: string;
  revision?: number;
  lockGranted?: boolean;
  overrides?: Record<string, RiskLevel>;
  decide?: "allow" | "deny";
}

async function run(steps: ScriptStep[], o: Options = {}) {
  const sdk = createFakeSdk([...steps, { type: "end", summary: "" }]);
  const fake = createFakeGateway({
    approvalResponder: (req) => ({
      type: "approval_response",
      approvalId: req.approvalId,
      decision: o.decide ?? "allow",
    }),
    lockResponder: (req) => ({
      type: "browser_lock_result",
      runId: req.runId,
      granted: o.lockGranted ?? true,
      ...(o.lockGranted === false ? { waitMessage: "A human holds the browser." } : {}),
    }),
  });
  const uses: Record<string, unknown>[] = [];
  const entry = {
    id: "vlt_1",
    name: "Console",
    type: "browser_login",
    targetOrigin: ORIGIN,
    revision: o.revision ?? 1,
    enabled: true,
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const answer = (body: unknown) => Response.json(body);
    if (path.endsWith("/vault/entries")) return answer({ entries: [entry] });
    if (path.endsWith("/vault/entries/vlt_1")) return answer({ entry });
    if (path.endsWith("/vault/fill")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      uses.push(body);
      const result: VaultUseResult = {
        status: "filled",
        ok: true,
        entryId: "vlt_1",
        revision: 1,
        operation: "fill",
        message: "The fields were filled. This does not mean you are signed in.",
      };
      return answer(result);
    }
    return fake.fetch(input, init);
  };
  const fs = createMemoryFs({
    [`${HOME}/SOUL.md`]: "You are Nova.",
    [browserStatePath(HOME, RUN)]: JSON.stringify({
      version: 1,
      runId: RUN,
      tabId: "tab-1",
      tabs: [{ id: "tab-1", url: o.tabUrl ?? `${ORIGIN}/login`, current: true }],
    }),
  });
  let clock = Date.parse("2026-10-17T10:00:00Z");
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch,
    fs,
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  await runOnce(request(o.overrides), deps, { approvalPollMs: 1, batchDelayMs: 1 });
  const calls = [...sdk.sessions.values()][0]?.toolCalls ?? [];
  const mark = await fs.readFile(vaultCapturePath(browserStatePath(HOME, RUN))).catch(() => "");
  return { calls, approvals: fake.approvals as ApprovalRequest[], uses, fake, mark };
}

const call = (name: string, input: Record<string, unknown>): ScriptStep => ({
  type: "tool_call",
  name,
  input,
  result: "ok",
});
const FILL = "mcp__deskmates__vault_fill";
const fillInput = { entryId: "vlt_1", revision: 1 };

describe("vault tools in the run", () => {
  it("lists without asking anyone", async () => {
    const { calls, approvals } = await run([call("mcp__deskmates__vault_list", {})]);
    expect(calls.map((c) => c.hookDecision)).toEqual(["allow"]);
    expect(calls[0]?.result).toContain("vlt_1");
    expect(approvals).toHaveLength(0);
  });

  it("asks for a fill as an L2 action bound to the exact entry, and hands its approval on", async () => {
    const { calls, approvals, uses, mark } = await run([call(FILL, fillInput)]);
    expect(approvals).toHaveLength(1);
    const asked = approvals[0];
    expect(asked?.riskLevel).toBe("L2");
    expect(asked?.action).toMatchObject({
      toolName: FILL,
      targetOrigin: ORIGIN,
      argumentSummary: "vault:vlt_1 rev:1 op:fill",
      argumentPattern: "vault:vlt_1 rev:1 op:fill",
      input: { entryId: "vlt_1", entryName: "Console", operation: "fill" },
    });
    expect(uses).toEqual([
      expect.objectContaining({
        entryId: "vlt_1",
        revision: 1,
        approvalId: asked?.approvalId,
        toolUseId: calls[0]?.toolUseId,
        tabId: "tab-1",
      }),
    ]);
    expect(calls[0]?.result).toContain("filled");
    expect(calls[0]?.result).toContain("does not mean you are signed in");
    expect(JSON.parse(mark)).toMatchObject({ version: 1, tabId: "tab-1", url: `${ORIGIN}/login` });
  });

  it("stays L2 under a workspace tier override", async () => {
    const { approvals } = await run([call(FILL, fillInput)], { overrides: { [FILL]: "L0" } });
    expect(approvals).toHaveLength(1);
  });

  it("refuses before asking: another origin, a stale revision, a human at the browser", async () => {
    const elsewhere = await run([call(FILL, fillInput)], {
      tabUrl: "https://evil.example.test/login",
    });
    expect(elsewhere.calls[0]?.hookDecision).toBe("deny");
    expect(elsewhere.approvals).toHaveLength(0);
    const stale = await run([call(FILL, fillInput)], { revision: 2 });
    expect(stale.calls[0]?.hookDecision).toBe("deny");
    expect(stale.approvals).toHaveLength(0);
    const held = await run([call(FILL, fillInput)], { lockGranted: false });
    expect(held.calls[0]?.hookDecision).toBe("deny");
    expect(held.approvals).toHaveLength(0);
    for (const r of [elsewhere, stale, held]) expect(r.uses).toHaveLength(0);
  });

  it("releases nothing when the approval is denied", async () => {
    const { calls, uses, mark } = await run([call(FILL, fillInput)], { decide: "deny" });
    expect(calls[0]?.hookDecision).toBe("deny");
    expect(uses).toHaveLength(0);
    expect(mark).toBe("");
  });

  it("puts references only in the ledger", async () => {
    const { fake } = await run([call(FILL, fillInput)]);
    expect(JSON.stringify(fake.events)).not.toContain(SECRET);
    expect(JSON.stringify(fake.events)).toContain('"entryId":"vlt_1"');
  });

  it("keys a release by its references whatever their order", () => {
    expect(vaultCallKey(FILL, { revision: 1, entryId: "a" })).toBe(
      vaultCallKey(FILL, { entryId: "a", revision: 1, frameUrl: undefined }),
    );
    expect(vaultCallKey(FILL, { entryId: "a", revision: 1 })).not.toBe(
      vaultCallKey(FILL, { entryId: "a", revision: 2 }),
    );
  });
});
