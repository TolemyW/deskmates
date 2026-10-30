// T1: the tool-level half of ADR-0027 amendment 1 decisions 10 and 11. The hook admits exactly
// the scheme, host and port a root-selected network profile grants, read from the Gateway before
// each check; `*` never admits a LAN target; a Gateway that cannot answer means no grants.

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
import { runOnce } from "../run-once.js";
import { type FakeGatewayOptions, createFakeGateway } from "../testing/fake-gateway.js";
import { createMemoryFs } from "../testing/in-memory-fs.js";

const HOME = "/home/nova";

function request(egressAllowlist: string[]): StartRunRequest {
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
          body: "Test the service",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-lan",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist,
    connectors: [],
    tools: ["thread_post"],
  };
}

const GRANTS: NetworkGrant[] = [
  { kind: "subnet", cidr: "10.88.30.0/24", schemes: ["http"], ports: [23001] },
  {
    kind: "host",
    hostname: "console.vendordb.lan",
    address: "10.88.36.35",
    schemes: ["https"],
    ports: [443],
  },
];

async function decide(steps: ScriptStep[], allowlist: string[], gateway: FakeGatewayOptions) {
  const sdk = createFakeSdk([...steps, { type: "end", summary: "" }]);
  const fake = createFakeGateway({ egressAllowlist: () => allowlist, ...gateway });
  let clock = Date.parse("2026-10-14T10:00:00Z");
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
  await runOnce(request(allowlist), deps, { approvalPollMs: 1, batchDelayMs: 1 });
  const calls = [...sdk.sessions.values()][0]?.toolCalls ?? [];
  return { calls, approvals: fake.approvals };
}

const navigate = (url: string): ScriptStep => ({
  type: "tool_call",
  name: "mcp__browser__browser_navigate",
  input: { url },
  result: "ok",
});
const curl = (url: string): ScriptStep => ({
  type: "tool_call",
  name: "Bash",
  input: { command: `curl -s ${url}` },
  result: "ok",
});

describe("pre-tool-use: network-profile grants (ADR-0027 amendment 1)", () => {
  it("admits exactly the granted LAN origins in navigation and shell fetches", async () => {
    const { calls, approvals } = await decide(
      [
        navigate("http://10.88.30.24:23001/"),
        curl("http://10.88.30.24:23001/api/health"),
        navigate("https://console.vendordb.lan/login"),
        navigate("http://10.88.30.24:23002/"),
        navigate("https://10.88.30.24:23001/"),
        curl("http://10.88.31.9:23001/"),
        curl("'http://10.88.30.24:23001/ok' http://10.0.0.5/"),
      ],
      ["*.example.test"],
      { egressGrants: () => GRANTS },
    );
    expect(calls.map((c) => c.hookDecision)).toEqual([
      "allow",
      "allow",
      "allow",
      "deny",
      "deny",
      "deny",
      "deny",
    ]);
    expect(calls[3]?.hookReason).toContain("egress_blocked: 10.88.30.24");
    expect(calls[6]?.hookReason).toContain("shell fetch to 10.0.0.5");
    // A LAN target is never asked for: it is granted or denied (ADR-0020 decision 3 as amended).
    expect(approvals).toHaveLength(0);
  });

  it("never admits a LAN target through the open-internet list", async () => {
    const { calls } = await decide(
      [navigate("http://10.88.30.24:23001/"), curl("http://10.88.30.24:23001/")],
      ["*"],
      {},
    );
    expect(calls.map((c) => c.hookDecision)).toEqual(["deny", "deny"]);
  });

  it("drops the grants when the Gateway cannot answer, and denies an expired grant", async () => {
    const down = await decide([navigate("http://10.88.30.24:23001/")], ["*.example.test"], {
      egressGrants: () => GRANTS,
      egressStatus: 500,
    });
    expect(down.calls.map((c) => c.hookDecision)).toEqual(["deny"]);
    const expired = await decide([navigate("http://10.88.30.24:23001/")], ["*.example.test"], {
      egressGrants: () => [{ ...(GRANTS[0] as NetworkGrant), expiresAt: "2000-01-01T00:00:00Z" }],
    });
    expect(expired.calls.map((c) => c.hookDecision)).toEqual(["deny"]);
  });
});
