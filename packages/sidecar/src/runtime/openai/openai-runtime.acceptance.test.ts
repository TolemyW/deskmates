// T3: the OpenAI runtime against a real model over the OpenAI Chat Completions protocol
// (ADR-0044). Skipped unless MODEL_BASE_URL, MODEL_AUTH_TOKEN and DEFAULT_MODEL are set; the
// endpoint must serve `/v1/chat/completions` for that model. The Gateway side is the fake
// Gateway of the T1 tests (approvals denied), so this exercises the loop, the tools and the gate
// with a real model, not the proxy.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SidecarDeps } from "../../deps.js";
import { runOnce } from "../../run-once.js";
import { createFakeGateway } from "../../testing/fake-gateway.js";
import { createMemoryFs } from "../../testing/in-memory-fs.js";
import { createOpenAiQuery } from "./openai-runtime.js";

const MODEL_BASE_URL = process.env.MODEL_BASE_URL;
const MODEL_AUTH_TOKEN = process.env.MODEL_AUTH_TOKEN;
const MODEL = process.env.DEFAULT_MODEL;
const configured = Boolean(MODEL_BASE_URL && MODEL_AUTH_TOKEN && MODEL);

let home: string;
let work: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "deskmates-oai-acc-home-"));
  work = await mkdtemp(join(tmpdir(), "deskmates-oai-acc-work-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

function makeDeps() {
  const gateway = createFakeGateway({ egressAllowlist: () => ["ops.example.test"] });
  const fs = createMemoryFs({
    [`${home}/SOUL.md`]: "You are Nova, a terse ops bot. Use tools when a file is mentioned.",
  });
  const env = { PATH: process.env.PATH ?? "/usr/bin" };
  const deps: SidecarDeps = {
    query: () => {
      throw new Error("the Claude SDK must not run on the openai-agents runtime");
    },
    queryOpenAi: createOpenAiQuery({ env, attachStdio: false, cwdOverride: work }),
    tool,
    createSdkMcpServer,
    fetch: gateway.fetch,
    fs,
    now: () => new Date(),
    env,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
  return { gateway, deps };
}

function request(body: string, runId = "run-acc-1"): StartRunRequest {
  return {
    runId: runId as RunId,
    botId: "bot-nova" as BotId,
    botName: "nova",
    workspaceId: "ws-1" as WorkspaceId,
    threadId: "thread-1" as ThreadId,
    botHomeDir: home,
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
          body,
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    runtime: "openai-agents",
    model: MODEL ?? "",
    cheapModel: MODEL ?? "",
    modelBaseUrl: MODEL_BASE_URL ?? "",
    modelAuthToken: MODEL_AUTH_TOKEN ?? "",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 2,
    maxTurns: 8,
    egressAllowlist: ["ops.example.test"],
    connectors: [],
    tools: ["thread_post"],
  };
}

describe.skipIf(!configured)("openai-agents runtime on a real model (T3)", () => {
  it("reads a file through the gated Read tool and answers with its content", async () => {
    await writeFile(join(work, "secret-word.txt"), "The secret word is PERIWINKLE.\n");
    const { gateway, deps } = makeDeps();
    const ended = await runOnce(
      request(
        `Read the file ${join(work, "secret-word.txt")} with the Read tool and reply with the secret word it contains, in one short sentence.`,
      ),
      deps,
      { approvalPollMs: 50, batchDelayMs: 1 },
    );
    expect(ended.outcome, ended.error).toBe("completed");
    const calls = gateway.events.filter((e) => e.kind === "tool_call").map((e) => e.payload);
    expect(calls.some((c) => c.toolName === "Read")).toBe(true);
    expect(calls.every((c) => c.riskLevel === "L0")).toBe(true);
    const text = `${ended.summary?.reply ?? ""} ${ended.summary?.done ?? ""}`;
    expect(text.toUpperCase()).toContain("PERIWINKLE");
    expect(ended.usage[0]?.model).toBe(MODEL);
    expect(
      (ended.usage[0]?.inputTokens ?? 0) + (ended.usage[0]?.cacheReadTokens ?? 0),
    ).toBeGreaterThan(0);
    expect(gateway.events.filter((e) => e.kind === "turn_usage").length).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it("has an L2 shell command judged by the gate and reports the refusal", async () => {
    const { gateway, deps } = makeDeps();
    const ended = await runOnce(
      request(
        "Run exactly this shell command with the Bash tool and report what happened: git push origin main",
        "run-acc-2",
      ),
      deps,
      { approvalPollMs: 50, batchDelayMs: 1 },
    );
    expect(ended.outcome, ended.error).toBe("completed");
    expect(gateway.approvals.length).toBeGreaterThanOrEqual(1);
    expect(gateway.approvals[0]).toMatchObject({ riskLevel: "L2", action: { toolName: "Bash" } });
    const denied = gateway.events.find(
      (e) => e.kind === "tool_result" && e.payload.isError === true,
    );
    expect(denied?.payload.content).toContain("denied");
  }, 120_000);
});
