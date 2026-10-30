// T0 (ADR-0048 amendment 1, A2): a run that froze the desktop tools gets the browser-or-desktop
// rule in its fixed guidance; every other run's system prompt is byte for byte what it was. The
// rule names the tools as the SDK exposes them. Whether the rule makes a bot better is a paired
// evaluation that is pending; this test only pins where the text goes.

import type { BotId, RunId, StartRunRequest, WorkspaceId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { buildContext } from "../context.js";
import { createMemoryFs } from "../testing/in-memory-fs.js";
import { DESKTOP_ROUTING_GUIDANCE } from "./desktop-guidance.js";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-guidance" as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    botRole: "ops bot",
    workspaceId: "ws-1" as WorkspaceId,
    workspaceName: "Ops",
    botHomeDir: "/home/nova",
    attempt: 1,
    trigger: { kind: "cron", prompt: "Save the report." },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "token",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: ["*"],
    connectors: [],
    tools: [],
    ...overrides,
  };
}

const NOW = new Date("2026-10-17T10:00:00Z");

describe("browser or desktop guidance (ADR-0048 amendment 1, A2)", () => {
  it("is in the fixed guidance of a desktop run only", async () => {
    const plain = await buildContext(request(), createMemoryFs({}), NOW);
    const desktop = await buildContext(
      request({ desktopTools: "lcu-v1" }),
      createMemoryFs({}),
      NOW,
    );
    expect(plain.systemPrompt).not.toContain("Choosing between the browser and the desktop tools");
    expect(desktop.systemPromptParts.static).toContain(DESKTOP_ROUTING_GUIDANCE);
    expect(desktop.systemPrompt.replace(`\n${DESKTOP_ROUTING_GUIDANCE}`, "")).toBe(
      plain.systemPrompt,
    );
  });

  it("names the tools as the SDK exposes them and says the desktop tools never drive Chromium", () => {
    expect(DESKTOP_ROUTING_GUIDANCE).toContain("mcp__browser__*");
    expect(DESKTOP_ROUTING_GUIDANCE).toContain("mcp__desktop__js");
    expect(DESKTOP_ROUTING_GUIDANCE).toContain("Never drive Chromium");
  });
});
