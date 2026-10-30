// T1 (ADR-0048 decisions 2, 3 and 6, owner rulings of 2026-10-17): a run with the desktop tools.
// Desktop calls are allowed without any approval request; their effect labels and literal targets
// ride on `tool_call`; a literal private address, IP literal or local name is denied unless a
// network profile grants it, and a locked workspace's unlisted host is denied without an ask; a
// human holding the workspace makes a desktop call wait; LCU from the shell is refused with the
// redirect; the tier table says L1; the `desktop` server is registered only with the capability.
// Amendment 1, A4: every desktop network denial leaves a `desktop`/`egress_denied` event with the
// host, the kind, the reason and the tool call, and never the URL.

import type {
  BotId,
  NetworkGrant,
  RunId,
  StartRunRequest,
  ThreadId,
  WorkspaceId,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "../deps.js";
import { classifyTool } from "../risk-tier.js";
import { runOnce } from "../run-once.js";
import { parseStartRunRequest } from "../start-run-request.js";
import { type FakeGatewayOptions, createFakeGateway } from "../testing/fake-gateway.js";
import { createMemoryFs } from "../testing/in-memory-fs.js";

const HOME = "/home/nova";
const DESKTOP_ENV = {
  PATH: "/usr/bin",
  DISPLAY: ":99",
  DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/deskmates/dbus-session",
  DESKMATES_IMAGE_CAPABILITIES: "desktop-lcu-v1",
  DESKMATES_DESKTOP_LCU_COMMAND: "/opt/lcu/current/bin/lcu",
  DESKMATES_DESKTOP_LCU_ARGS: "",
  DESKMATES_DESKTOP_LCU_VERSION: "0.11.3",
};

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-desk" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    botRole: "ops bot",
    workspaceId: "ws-1" as WorkspaceId,
    workspaceName: "Ops",
    threadId: "thread-1" as ThreadId,
    botHomeDir: HOME,
    attempt: 1,
    trigger: { kind: "cron", prompt: "Save the report." },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-desktop-7c1d",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: ["*"],
    connectors: [],
    tools: ["thread_post"],
    desktopTools: "lcu-v1",
    ...overrides,
  };
}

async function run(
  steps: ScriptStep[],
  opts: {
    request?: Partial<StartRunRequest>;
    gateway?: FakeGatewayOptions;
    allowlist?: string[];
    env?: Record<string, string>;
    /** A run that did not freeze the desktop tools. */
    noDesktop?: boolean;
  } = {},
) {
  const sdk = createFakeSdk([...steps, { type: "end", summary: "" }]);
  const allowlist = opts.allowlist ?? ["*"];
  const fake = createFakeGateway({ egressAllowlist: () => allowlist, ...opts.gateway });
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: fake.fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => new Date("2026-10-17T10:00:00Z"),
    env: opts.env ?? DESKTOP_ENV,
    sleep: async () => {},
  };
  const { desktopTools: _frozen, ...withoutDesktop } = request({
    egressAllowlist: allowlist,
    ...opts.request,
  });
  const req = opts.noDesktop
    ? withoutDesktop
    : { ...withoutDesktop, desktopTools: "lcu-v1" as const };
  await runOnce(req, deps, {
    approvalPollMs: 1,
    batchDelayMs: 1,
  });
  const session = [...sdk.sessions.values()][0];
  return {
    calls: session?.toolCalls ?? [],
    options: session?.calls[0]?.options,
    fake,
  };
}

const js = (code: string): ScriptStep => ({
  type: "tool_call",
  name: "mcp__desktop__js",
  input: { code },
  result: "ok",
});

describe("desktop calls are allowed without asking (decision 2)", () => {
  it("allows read, input, side-effect input and launch alike, with no approval request", async () => {
    const { calls, fake } = await run([
      js("const s = await cua.getState(); s"),
      js("await window.type('hello')"),
      js("await button('Send').click()"),
      js("require('child_process').spawn('gedit')"),
      { type: "tool_call", name: "mcp__desktop__js_reset", input: {}, result: "ok" },
    ]);
    expect(calls.map((c) => c.hookDecision)).toEqual(["allow", "allow", "allow", "allow", "allow"]);
    expect(fake.approvals).toHaveLength(0);
    const toolCalls = fake.events.filter((e) => e.kind === "tool_call").map((e) => e.payload);
    expect(toolCalls.map((p) => [p.riskLevel, p.desktopEffects])).toEqual([
      ["L1", ["read"]],
      ["L1", ["input"]],
      ["L1", ["input send"]],
      ["L1", ["launch"]],
      ["L1", []],
    ]);
  });

  it("records literal targets and applies the hard denies to them", async () => {
    const { calls, fake } = await run(
      [
        js("await fetch('https://status.example.test/ok')"),
        js("await fetch('http://10.1.2.3/admin')"),
        js("await fetch('http://169.254.169.254/latest/meta-data')"),
        js("open('http://localhost:8080/')"),
        js("await fetch('http://10.88.30.24:23001/api')"),
      ],
      {
        gateway: {
          egressGrants: (): NetworkGrant[] => [
            { kind: "subnet", cidr: "10.88.30.0/24", schemes: ["http"], ports: [23001] },
          ],
        },
      },
    );
    expect(calls.map((c) => c.hookDecision)).toEqual(["allow", "deny", "deny", "deny", "allow"]);
    expect(calls[1]?.hookReason).toContain("egress_blocked: desktop code names 10.1.2.3");
    expect(fake.approvals).toHaveLength(0);
    const denials = fake.events
      .filter((e) => e.kind === "log" && e.payload.op === "egress_denied")
      .map((e) => e.payload);
    expect(denials.map((d) => [d.source, d.level, d.host, d.kind, d.toolName])).toEqual([
      ["desktop", "warn", "10.1.2.3", "hard_deny", "mcp__desktop__js"],
      ["desktop", "warn", "169.254.169.254", "hard_deny", "mcp__desktop__js"],
      ["desktop", "warn", "localhost", "hard_deny", "mcp__desktop__js"],
    ]);
    expect(denials.map((d) => d.toolUseId)).toEqual(
      [1, 2, 3].map((i) => calls[i]?.toolUseId ?? "missing"),
    );
    expect(JSON.stringify(denials)).not.toContain("/admin");
    const first = fake.events.find((e) => e.kind === "tool_call")?.payload;
    expect(first?.desktopTargets).toEqual(["https://status.example.test/ok"]);
    expect(first?.desktopEffects).toEqual(["network"]);
  });

  it("denies an unlisted public host in a locked workspace instead of asking", async () => {
    const { calls, fake } = await run(
      [
        js("await fetch('https://docs.example.test/')"),
        js("await fetch('https://elsewhere.test/')"),
      ],
      { allowlist: ["docs.example.test"] },
    );
    expect(calls.map((c) => c.hookDecision)).toEqual(["allow", "deny"]);
    expect(calls[1]?.hookReason).toContain("desktop calls do not ask");
    expect(fake.approvals).toHaveLength(0);
    const denial = fake.events.find((e) => e.kind === "log" && e.payload.op === "egress_denied");
    expect(denial?.payload).toMatchObject({
      source: "desktop",
      host: "elsewhere.test",
      kind: "not_in_allowlist",
      reason: calls[1]?.hookReason,
      toolUseId: calls[1]?.toolUseId,
    });
  });

  it("is L1 in the tier table, and any other desktop-server name is untabled", () => {
    expect(classifyTool("mcp__desktop__js", { code: "x" })).toEqual({ level: "L1" });
    expect(classifyTool("mcp__desktop__js_reset", {})).toEqual({ level: "L1" });
    expect(classifyTool("mcp__desktop__turn_ended", {})).toEqual({
      level: "L2",
      unclassified: true,
    });
  });

  it("denies a desktop call on a run that did not freeze the tools", async () => {
    const { calls } = await run([js("await cua.getState()")], {
      noDesktop: true,
    });
    expect(calls.map((c) => c.hookDecision)).toEqual(["deny"]);
  });
});

describe("desktop calls stop while a human holds the workspace (decision 6, amendment 1 A3)", () => {
  it("probe the shared screen and wait while a human holds the workspace", async () => {
    const { calls, fake } = await run([js("await cua.getState()")], {
      gateway: {
        desktopLockResponder: (req) => ({
          type: "desktop_lock_result",
          runId: req.runId,
          granted: false,
          waitMessage: "A human is using the screen; wait.",
        }),
      },
    });
    expect(calls.map((c) => c.hookDecision)).toEqual(["deny"]);
    expect(calls[0]?.hookReason).toBe("A human is using the screen; wait.");
    expect(fake.desktopLocks.map((l) => l.op)).toEqual(["probe"]);
    // The hook takes no browser lease for a desktop call; the proxy takes the screen lease.
    expect(fake.locks).toEqual([]);
    expect(fake.events.some((e) => e.kind === "takeover")).toBe(true);
  });
});

describe("LCU from the shell (decision 3)", () => {
  it("is refused with the redirect when the tools are on, and with the off notice otherwise", async () => {
    const on = await run([
      {
        type: "tool_call",
        name: "Bash",
        input: { command: "/opt/lcu/current/bin/lcu" },
        result: "",
      },
      { type: "tool_call", name: "Bash", input: { command: "echo lcu is a word" }, result: "" },
    ]);
    expect(on.calls.map((c) => c.hookDecision)).toEqual(["deny", "allow"]);
    expect(on.calls[0]?.hookReason).toContain("mcp__desktop__js");
    const off = await run(
      [
        {
          type: "tool_call",
          name: "Bash",
          input: { command: "cd /tmp && lcu doctor" },
          result: "",
        },
      ],
      { noDesktop: true },
    );
    expect(off.calls[0]?.hookReason).toContain("not enabled for this bot");
  });
});

describe("registration (decision 3)", () => {
  it("adds exactly one desktop server behind the sidecar proxy, with settingSources empty", async () => {
    const { options, fake } = await run([]);
    const servers = options?.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers).sort()).toEqual(["browser", "deskmates", "desktop"]);
    expect(servers.desktop).toMatchObject({
      type: "stdio",
      command: "deskmates-sidecar",
      args: ["desktop-proxy", "--", "/opt/lcu/current/bin/lcu"],
    });
    const env = servers.desktop?.env as Record<string, string>;
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/deskmates/dbus-session");
    expect(JSON.parse(env.DESKMATES_DESKTOP_COORDINATION ?? "{}")).toMatchObject({
      runId: "run-desk",
      attempt: 1,
      resumed: false,
    });
    expect(options?.settingSources).toEqual([]);
    expect(
      fake.events.some(
        (e) => e.kind === "log" && e.payload.source === "desktop" && e.payload.op === "registered",
      ),
    ).toBe(true);
  });

  it("registers nothing without the image capability, and says so", async () => {
    const { options, fake } = await run([], { env: { PATH: "/usr/bin" } });
    expect(Object.keys(options?.mcpServers ?? {})).not.toContain("desktop");
    expect(fake.events.some((e) => e.kind === "log" && e.payload.op === "capability_missing")).toBe(
      true,
    );
    const off = await run([], { noDesktop: true });
    expect(Object.keys(off.options?.mcpServers ?? {})).not.toContain("desktop");
  });

  it("accepts lcu-v1 on the start request and nothing else", () => {
    expect(parseStartRunRequest(JSON.stringify(request())).ok).toBe(true);
    expect(parseStartRunRequest(JSON.stringify({ ...request(), desktopTools: "lcu-v2" })).ok).toBe(
      false,
    );
  });
});
