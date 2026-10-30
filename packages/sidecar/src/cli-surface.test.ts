// T0/T1: the CLI surface the Gateway sends (ADR-0023 amendment 5, decision 24). Without the field
// the SDK gets exactly the options it always had; with it, the extra names join the fixed
// withheld list and the switches become inline `settings`. Only built-in names get through stdin.

import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { DISALLOWED_TOOLS, cliSettingsFor, disallowedToolsFor, runOnce } from "./run-once.js";
import { parseStartRunRequest } from "./start-run-request.js";
import { createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const HOME = "/home/nova";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-cli" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    botRole: "ops bot",
    workspaceId: "ws-1" as WorkspaceId,
    workspaceName: "Ops",
    threadId: "thread-1" as ThreadId,
    botHomeDir: HOME,
    attempt: 1,
    trigger: { kind: "cron", prompt: "Sweep." },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test",
    modelAuthToken: "deskmates-run-token-cli-surface-4a9e",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: [],
    connectors: [],
    tools: ["thread_post"],
    ...overrides,
  };
}

async function sdkOptions(overrides: Partial<StartRunRequest> = {}) {
  const sdk = createFakeSdk([{ type: "end", summary: "ok" }]);
  const gateway = createFakeGateway({ egressAllowlist: () => [] });
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: gateway.fetch,
    fs: createMemoryFs({ [`${HOME}/SOUL.md`]: "You are Nova." }),
    now: () => new Date("2026-10-16T10:00:00Z"),
    env: { PATH: "/usr/bin" },
    sleep: async () => {},
  };
  await runOnce(request(overrides), deps, { approvalPollMs: 1, batchDelayMs: 1 });
  const options = [...sdk.sessions.values()][0]?.calls[0]?.options;
  if (!options) throw new Error("no query");
  return options;
}

describe("the SDK options a run gets", () => {
  it("are what they always were when the request has no cliSurface", async () => {
    const options = await sdkOptions();
    expect(options.disallowedTools).toEqual([...DISALLOWED_TOOLS]);
    expect(options).not.toHaveProperty("settings");
  });

  it("withhold the extra names after the fixed ones and pass the switches as settings", async () => {
    const options = await sdkOptions({
      cliSurface: {
        disallowedTools: ["NotebookEdit", "WebFetch"],
        disableBundledSkills: true,
        includeGitInstructions: false,
        skillListingMaxDescChars: 200,
      },
    });
    expect(options.disallowedTools).toEqual([...DISALLOWED_TOOLS, "NotebookEdit"]);
    expect((options as { settings?: unknown }).settings).toEqual({
      disableBundledSkills: true,
      includeGitInstructions: false,
      skillListingMaxDescChars: 200,
    });
  });

  it("never lose a fixed name, and send no settings for a tool list alone", () => {
    const req = { cliSurface: { disallowedTools: ["TodoWrite"] } };
    expect(disallowedToolsFor(req).slice(0, DISALLOWED_TOOLS.length)).toEqual([
      ...DISALLOWED_TOOLS,
    ]);
    expect(cliSettingsFor(req)).toEqual({});
    expect(cliSettingsFor({})).toEqual({});
  });
});

describe("parseStartRunRequest and cliSurface", () => {
  const raw = (cliSurface: unknown) => JSON.stringify({ ...request(), cliSurface });

  it("keeps a valid surface", () => {
    const parsed = parseStartRunRequest(
      raw({ disallowedTools: ["NotebookEdit"], includeGitInstructions: false }),
    );
    expect(parsed.ok && parsed.value.cliSurface).toEqual({
      disallowedTools: ["NotebookEdit"],
      includeGitInstructions: false,
    });
  });

  it("refuses an MCP name, a non-boolean switch and a cap that is not positive", () => {
    for (const bad of [
      { disallowedTools: ["mcp__deskmates__thread_post"] },
      { disableBundledSkills: "true" },
      { skillListingMaxDescChars: 0 },
    ]) {
      expect(parseStartRunRequest(raw(bad)).ok, JSON.stringify(bad)).toBe(false);
    }
  });
});
