// T1: what the OpenAI runtime carries beyond the loop and the gate (ADR-0042): the reply
// preview and per-turn usage from the model stream, the Skill tool, compaction across runs, and
// model jobs on the same runtime. Same harness shape as openai-runtime.test.ts.

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { BotId, RunId, StartRunRequest, ThreadId, WorkspaceId } from "@deskmates/contracts";
import {
  type FakeOpenAiServer,
  type FakeOpenAiStep,
  type FakeOpenAiUsage,
  type RecordedChatRequest,
  startFakeOpenAiServer,
} from "@deskmates/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SidecarDeps } from "../../deps.js";
import { runOnce } from "../../run-once.js";
import { type FakeGatewayOptions, createFakeGateway } from "../../testing/fake-gateway.js";
import { createMemoryFs } from "../../testing/in-memory-fs.js";
import { createOpenAiCompletion } from "./complete.js";
import { sessionDirOf } from "./file-session.js";
import { createOpenAiQuery } from "./openai-runtime.js";

const TOKEN = "run-token-under-test";
const MODEL = "oai-model-under-test";

let home: string;
let work: string;
let fake: FakeOpenAiServer;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "deskmates-oai-home-"));
  work = await mkdtemp(join(tmpdir(), "deskmates-oai-work-"));
});

afterEach(async () => {
  await fake?.close();
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
});

const summaryBlock = (reply: string, done = "did the thing") =>
  `${reply}\n\`\`\`json\n${JSON.stringify({
    done,
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
  })}\n\`\`\``;

function baseRequest(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-1" as RunId,
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
          body: "Check the ticket queue",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    runtime: "openai-agents",
    model: MODEL,
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: fake.baseUrl,
    modelAuthToken: TOKEN,
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 20,
    egressAllowlist: ["ops.example.test"],
    connectors: [],
    tools: [],
    ...overrides,
  };
}

async function makeDeps(
  steps: FakeOpenAiStep[] | ((request: RecordedChatRequest) => FakeOpenAiStep),
  opts: {
    gateway?: FakeGatewayOptions;
    usage?: (index: number) => FakeOpenAiUsage;
    env?: Record<string, string>;
  } = {},
) {
  fake = await startFakeOpenAiServer({
    steps,
    usage:
      opts.usage ??
      ((index) => ({ promptTokens: 20 + index, completionTokens: 5, cachedTokens: 4 })),
  });
  const gateway = createFakeGateway({
    egressAllowlist: () => ["ops.example.test"],
    ...opts.gateway,
  });
  const fs = createMemoryFs({ [`${home}/SOUL.md`]: "You are Nova, the ops bot." });
  let clock = Date.parse("2026-10-16T10:00:00Z");
  const env = { PATH: process.env.PATH ?? "/usr/bin", ...opts.env };
  const deps: SidecarDeps = {
    query: () => {
      throw new Error("the Claude SDK must not run on the openai-agents runtime");
    },
    queryOpenAi: createOpenAiQuery({ env, attachStdio: false, cwdOverride: work }),
    completeOpenAi: createOpenAiCompletion(),
    tool,
    createSdkMcpServer,
    fetch: gateway.fetch,
    fs,
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env,
    sleep: async () => {},
  };
  return { gateway, deps };
}

const run = (deps: SidecarDeps, request: StartRunRequest) =>
  runOnce(request, deps, { approvalPollMs: 1, batchDelayMs: 1 });

describe("openai-agents runtime: the model stream", () => {
  it("emits one turn_usage per model response and streams the reply preview", async () => {
    const { gateway, deps } = await makeDeps([
      { toolCalls: [{ name: "LS", arguments: { path: work } }] },
      { text: summaryBlock("Listed the directory.") },
    ]);
    const ended = await run(deps, baseRequest());
    expect(ended.outcome).toBe("completed");
    const turns = gateway.events.filter((e) => e.kind === "turn_usage").map((e) => e.payload);
    expect(turns).toEqual([
      expect.objectContaining({
        model: MODEL,
        turn: 1,
        inputTokens: 16,
        outputTokens: 5,
        cacheReadTokens: 4,
      }),
      expect.objectContaining({
        model: MODEL,
        turn: 2,
        inputTokens: 17,
        outputTokens: 5,
        cacheReadTokens: 4,
      }),
    ]);
    // ADR-0037 decision 7: the preview is the reply as it is written; the final frame is the reply.
    expect(gateway.previews.length).toBeGreaterThan(0);
    expect(gateway.previews.at(-1)?.text).toBe("Listed the directory.");
  });
});

describe("openai-agents runtime: skills (ADR-0015)", () => {
  it("offers the Skill tool for the run's set and loads one skill's SKILL.md, measured by the hook", async () => {
    const { gateway, deps } = await makeDeps([
      { toolCalls: [{ name: "Skill", arguments: { skill: "triage" } }] },
      { text: summaryBlock("Triaged.") },
    ]);
    const ended = await run(
      deps,
      baseRequest({
        skills: [
          {
            skillId: "skill-triage",
            name: "triage",
            version: 1,
            sha256: "0".repeat(64),
            files: [{ path: "SKILL.md", content: "# Triage\nSort tickets by age." }],
          },
        ],
      }),
    );
    expect(ended.outcome).toBe("completed");
    expect(fake.requests[0]?.tools).toContain("Skill");
    const toolMessage = (fake.requests[1]?.messages as { role: string; content: unknown }[]).find(
      (m) => m.role === "tool",
    );
    expect(String(toolMessage?.content)).toContain("Sort tickets by age.");
    expect(gateway.events.find((e) => e.kind === "skill_used")?.payload).toMatchObject({
      skill: "triage",
    });
    expect(gateway.events.find((e) => e.kind === "tool_call")?.payload).toMatchObject({
      toolName: "Skill",
      riskLevel: "L0",
    });
  });

  it("refuses a skill outside the set without reading anything", async () => {
    const { deps } = await makeDeps([
      { toolCalls: [{ name: "Skill", arguments: { skill: "other" } }] },
      { text: summaryBlock("No.") },
    ]);
    await run(
      deps,
      baseRequest({
        skills: [
          {
            skillId: "skill-triage",
            name: "triage",
            version: 1,
            sha256: "0".repeat(64),
            files: [{ path: "SKILL.md", content: "x" }],
          },
        ],
      }),
    );
    const toolMessage = (fake.requests[1]?.messages as { role: string; content: unknown }[]).find(
      (m) => m.role === "tool",
    );
    expect(String(toolMessage?.content)).toMatch(/No enabled skill named other/);
  });
});

describe("openai-agents runtime: compaction (summary-v1)", () => {
  it("summarises the history once the last prompt was over the knob, archives it and reports the boundary", async () => {
    const { gateway, deps } = await makeDeps(
      // The summary call is the one made without tools; every other request is a turn.
      (req) =>
        req.tools.length === 0
          ? { text: "SUMMARY OF THE PAST" }
          : { text: summaryBlock(`Reply ${req.index}.`) },
      {
        // The first three turns report prompts over the knob; the history is short at first (the
        // kept tail covers it), so compaction happens on the run whose history outgrows the tail.
        usage: (index) => ({ promptTokens: index <= 2 ? 5000 : 30, completionTokens: 5 }),
        env: { DESKMATES_OPENAI_MAX_CONTEXT_TOKENS: "4000" },
      },
    );
    const first = await run(deps, baseRequest());
    expect(first.outcome).toBe("completed");
    expect(first.maxContextTokens).toBe(4000);
    for (let i = 0; i < 4; i++) {
      const padded = await run(
        deps,
        baseRequest({ runId: `run-pad-${i}` as RunId, sdkSessionId: first.sdkSessionId ?? "" }),
      );
      expect(padded.outcome, `pad ${i}`).toBe("completed");
    }
    const events = gateway.events.filter((e) => e.kind === "compact_boundary");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ trigger: "auto", preTokens: 5000 });
    // One summary call, and the turn after it starts from the summary.
    const summaryIndex = fake.requests.findIndex((r) => r.tools.length === 0);
    expect(summaryIndex).toBeGreaterThan(0);
    expect(fake.requests.filter((r) => r.tools.length === 0)).toHaveLength(1);
    expect(JSON.stringify(fake.requests[summaryIndex + 1]?.messages)).toContain(
      "SUMMARY OF THE PAST",
    );
    const files = (await readdir(sessionDirOf(home))).sort();
    expect(files.some((f) => f.includes(".compacted-"))).toBe(true);
  });
});

describe("openai-agents runtime: model jobs (decision 7)", () => {
  it("runs a tool-free job as one Chat Completions turn with its usage", async () => {
    const { gateway, deps } = await makeDeps([{ text: "The image is red." }], {
      usage: () => ({ promptTokens: 40, completionTokens: 3, cachedTokens: 10 }),
    });
    const ended = await run(
      deps,
      baseRequest({
        modelJob: { kind: "vision_probe", code: "4271" },
        tools: [],
      }),
    );
    expect(ended.outcome).toBe("completed");
    expect(ended.summary?.reply).toBe("The image is red.");
    expect(ended.usage).toEqual([
      expect.objectContaining({
        model: MODEL,
        inputTokens: 30,
        outputTokens: 3,
        cacheReadTokens: 10,
      }),
    ]);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.tools).toEqual([]);
    const user = (
      fake.requests[0]?.messages as { role: string; content: { type: string }[] }[]
    ).find((m) => m.role === "user");
    expect(user?.content.map((c) => c.type)).toEqual(["image_url", "text"]);
    expect(gateway.events.find((e) => e.kind === "turn_usage")?.payload).toMatchObject({
      inputTokens: 30,
    });
  });
});
