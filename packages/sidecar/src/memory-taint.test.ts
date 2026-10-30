// T0 (ADR-0011 Verification row 3): trust comes from the run's taint, never from the model. A fake
// SDK script reads a browser result after response N; items the summary places before N + 1 are
// trusted, the rest untrusted, and a summary that claims `trusted` is overridden. Webhook bodies,
// other bots' messages, shell fetches, untrusted memory results and a tainted resumed session
// taint the same way.

import {
  type BotId,
  type LearnedItem,
  type RunId,
  type StartRunRequest,
  type ThreadId,
  type WorkspaceId,
  wrapUntrusted,
} from "@deskmates/contracts";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import { describe, expect, it } from "vitest";
import type { SidecarDeps } from "./deps.js";
import { MEMORY_SEARCH_TOOL, TaintTracker } from "./memory-taint.js";
import { runOnce } from "./run-once.js";
import { type FakeGatewayOptions, createFakeGateway } from "./testing/fake-gateway.js";
import { createMemoryFs } from "./testing/in-memory-fs.js";

const HOME = "/home/nova";

function request(overrides: Partial<StartRunRequest> = {}): StartRunRequest {
  return {
    runId: "run-taint" as RunId,
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
          body: "Check the S3 price page",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    model: "model-under-test",
    cheapModel: "cheap-model-under-test",
    modelBaseUrl: "http://gateway.test/model",
    modelAuthToken: "deskmates-run-token-taint-1234",
    gatewayBaseUrl: "http://gateway.test",
    shortWaitSeconds: 300,
    maxTurns: 50,
    egressAllowlist: ["prices.example.test"],
    connectors: [],
    tools: ["thread_post", "memory_search"],
    ...overrides,
  };
}

const summary = (learned: unknown[]) =>
  `\`\`\`json\n${JSON.stringify({ done: "checked", reply: "done", learned })}\n\`\`\``;

async function run(
  script: ScriptStep[],
  req: StartRunRequest = request(),
  gatewayOpts: FakeGatewayOptions = {},
) {
  const sdk = createFakeSdk(script);
  const gateway = createFakeGateway({
    egressAllowlist: () => req.egressAllowlist,
    ...gatewayOpts,
  });
  let clock = Date.parse("2026-09-29T10:00:00Z");
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
  return { ended, gateway };
}

const trustOf = (items: readonly LearnedItem[] | undefined) =>
  (items ?? []).map((item) => [item.body, item.turn, item.trust]);

describe("run taint through runOnce", () => {
  it("trusts items before the browser result and not after, whatever the model claims", async () => {
    const final = summary([
      { body: "Before the page.", scope: "workspace", turn: 2, trust: "trusted" },
      { body: "After the page.", scope: "workspace", turn: 4, trust: "trusted" },
      { body: "At the read.", scope: "task", turn: 3, trust: "trusted" },
    ]);
    const { ended } = await run([
      { type: "text", text: "Planning." }, // response 1
      {
        type: "tool_call",
        name: "Write",
        input: { file_path: "/work/plan.md", content: "plan" },
        result: "ok",
      }, // response 2
      {
        type: "tool_call",
        name: "mcp__browser__browser_navigate",
        input: { url: "https://prices.example.test/s3" },
        result: "egress: 0 (billed separately)",
      }, // response 3; its result is first read by response 4
      { type: "text", text: final }, // response 4
      { type: "end", summary: final },
    ]);
    expect(ended.outcome).toBe("completed");
    expect(trustOf(ended.summary?.learned)).toEqual([
      ["Before the page.", 2, "trusted"],
      ["After the page.", 4, "untrusted"],
      ["At the read.", 3, "trusted"],
    ]);
    expect(ended.summary?.learned?.[1]?.sourceKind).toBe("page");
    expect(ended.taint).toEqual({ turns: 4, taintedAtTurn: 4, sourceKind: "page" });
  });

  it("maps legacy memorySuggestions to bot candidates at the last turn", async () => {
    const final = `\`\`\`json\n${JSON.stringify({
      done: "d",
      reply: "r",
      memorySuggestions: ["Export before closing."],
    })}\n\`\`\``;
    const { ended } = await run([
      {
        type: "tool_call",
        name: "mcp__browser__browser_snapshot",
        input: {},
        result: "page text",
      },
      { type: "text", text: final },
      { type: "end", summary: final },
    ]);
    expect(ended.summary?.learned).toEqual([
      {
        body: "Export before closing.",
        proposedScope: "bot",
        authority: "procedure",
        turn: 2,
        observedAt: expect.any(String),
        trust: "untrusted",
        sourceKind: "page",
      },
    ]);
  });

  it("taints from turn 1 when a teammate bot's message is in the delivery", async () => {
    const final = summary([{ body: "Fact.", scope: "workspace", turn: 1 }]);
    const req = request({
      trigger: {
        kind: "thread_message",
        thread: { id: "thread-1" as ThreadId, kind: "chat", title: "Ops" },
        messages: [
          {
            seq: 1,
            authorKind: "bot",
            authorId: "bot-orion",
            authorName: "orion",
            body: "The limit is 12.",
            attachments: [],
          },
        ],
        relayCount: 0,
      },
    });
    const { ended } = await run([{ type: "end", summary: final }], req);
    expect(trustOf(ended.summary?.learned)).toEqual([["Fact.", 1, "untrusted"]]);
    expect(ended.summary?.learned?.[0]?.sourceKind).toBe("other_bot");
  });

  it("taints after a memory_search that returned an untrusted entry, not after a trusted one", async () => {
    const hit = (trust: "trusted" | "untrusted", id: string) => ({
      id,
      version: 1,
      scope: "workspace" as const,
      kind: "note" as const,
      body: `entry ${id}`,
      authority: "fact" as const,
      trust,
      observedAt: "2026-09-29T00:00:00.000Z",
    });
    const final = summary([{ body: "Later.", scope: "workspace", turn: 3 }]);
    const { ended } = await run(
      [
        { type: "tool_call", name: MEMORY_SEARCH_TOOL, input: { query: "trusted" } }, // 1
        { type: "tool_call", name: MEMORY_SEARCH_TOOL, input: { query: "mixed" } }, // 2
        { type: "text", text: final }, // 3
        { type: "end", summary: final },
      ],
      request(),
      {
        memorySearch: (query) =>
          query === "trusted"
            ? [hit("trusted", "a")]
            : [hit("trusted", "a"), hit("untrusted", "b")],
      },
    );
    expect(ended.taint).toEqual({ turns: 3, taintedAtTurn: 3, sourceKind: "tool" });
    expect(trustOf(ended.summary?.learned)).toEqual([["Later.", 3, "untrusted"]]);
  });

  it("starts tainted on a resumed session the Gateway marked tainted", async () => {
    const final = summary([{ body: "Fact.", scope: "workspace", turn: 1 }]);
    const { ended } = await run(
      [{ type: "end", summary: final }],
      request({ sessionTainted: true, sdkSessionId: "session-1" }),
    );
    expect(trustOf(ended.summary?.learned)).toEqual([["Fact.", 1, "untrusted"]]);
  });

  it("ledgers the taint and stamped items at a PreCompact boundary", async () => {
    const final = summary([]);
    const { gateway } = await run([
      {
        type: "tool_call",
        name: "mcp__browser__browser_navigate",
        input: { url: "https://prices.example.test/s3" },
        result: "page",
      },
      { type: "text", text: summary([{ body: "Partial.", scope: "task", turn: 1 }]) },
      { type: "compact", preTokens: 1000 },
      { type: "end", summary: final },
    ]);
    const flush = gateway.events.find(
      (e) =>
        e.kind === "log" && e.payload.source === "pre_compact" && e.payload.op === "memory_flush",
    );
    expect(flush?.payload).toMatchObject({
      taint: { turns: 2, taintedAtTurn: 2, sourceKind: "page" },
      learned: [{ body: "Partial.", turn: 1, trust: "trusted" }],
    });
  });
});

describe("TaintTracker", () => {
  const cron = { kind: "cron" as const, prompt: "go" };

  it("taints on a system notice that quotes another bot's reply, not on a plain one", () => {
    const trigger = (body: string) => ({
      kind: "thread_message" as const,
      thread: { id: "t" as ThreadId, kind: "chat" as const, title: "t" },
      messages: [
        {
          seq: 3,
          authorKind: "system" as const,
          authorId: "",
          authorName: "system",
          body,
          attachments: [],
        },
      ],
      relayCount: 0,
    });
    // ADR-0016 amendment 1, decision 9: a cross-thread delegation outcome carries the bot wrapper.
    const quoted = new TaintTracker({
      trigger: trigger(
        `Delegation outcome: expert finished (succeeded).\nReply:\n${wrapUntrusted("bot:expert", "closed 1050")}`,
      ),
    });
    expect(quoted.snapshot()).toEqual({ turns: 0, taintedAtTurn: 1, sourceKind: "other_bot" });
    const plain = new TaintTracker({
      trigger: trigger("Delegation outcome: expert failed the work: boom. No reply was posted."),
    });
    expect(plain.snapshot()).toEqual({ turns: 0 });
  });

  it("taints on a webhook trigger", () => {
    const t = new TaintTracker({ trigger: { kind: "webhook", body: "{}" } });
    expect(t.snapshot()).toEqual({ turns: 0, taintedAtTurn: 1, sourceKind: "webhook" });
  });

  it("counts a response split over several messages once", () => {
    const t = new TaintTracker({ trigger: cron });
    t.observeAssistant("m1");
    t.observeAssistant("m1");
    t.observeAssistant("m2");
    expect(t.turnCount).toBe(2);
  });

  it("taints on a shell fetch but not on other shell commands", () => {
    const t = new TaintTracker({ trigger: cron });
    t.observeAssistant("m1");
    t.observeToolUse("a", "Bash", { command: "ls /work" });
    t.observeToolResult("a", "files");
    expect(t.snapshot().taintedAtTurn).toBeUndefined();
    t.observeAssistant("m2");
    t.observeToolUse("b", "Bash", { command: "curl https://prices.example.test/s3.json" });
    t.observeToolResult("b", "{}");
    expect(t.snapshot()).toMatchObject({ taintedAtTurn: 3, sourceKind: "page" });
  });

  it("reads an unplaceable turn as the last one", () => {
    const t = new TaintTracker({ trigger: cron });
    t.observeAssistant("m1");
    t.observeToolUse("a", "mcp__browser__browser_snapshot", {});
    t.observeToolResult("a", "page");
    t.observeAssistant("m2");
    const items: LearnedItem[] = [
      { body: "zero", proposedScope: "workspace", authority: "fact", turn: 0 },
      { body: "future", proposedScope: "workspace", authority: "fact", turn: 99 },
      { body: "fraction", proposedScope: "workspace", authority: "fact", turn: 1.5 },
      { body: "first", proposedScope: "workspace", authority: "fact", turn: 1 },
    ];
    expect(t.stamp(items).map((i) => [i.body, i.turn, i.trust])).toEqual([
      ["zero", 2, "untrusted"],
      ["future", 2, "untrusted"],
      ["fraction", 2, "untrusted"],
      ["first", 1, "trusted"],
    ]);
  });

  it("stamps each item with the time of the turn it names, ignoring a model's time (A9)", () => {
    let tick = Date.parse("2026-10-13T10:00:00.000Z");
    const clock = () => {
      tick += 60_000;
      return new Date(tick);
    };
    const t = new TaintTracker({ trigger: cron, clock });
    t.observeAssistant("m1");
    t.observeAssistant("m2");
    const stamped = t.stamp([
      { body: "one", proposedScope: "workspace", authority: "fact", turn: 1 },
      {
        body: "two",
        proposedScope: "workspace",
        authority: "fact",
        turn: 2,
        observedAt: "2099-01-01T00:00:00.000Z",
      },
    ]);
    expect(stamped.map((i) => i.observedAt)).toEqual([
      "2026-10-13T10:01:00.000Z",
      "2026-10-13T10:02:00.000Z",
    ]);
  });

  it("marks only learning after a transient failure", () => {
    const t = new TaintTracker({ trigger: cron });
    t.observeAssistant("m1");
    t.markDoNotLearn("egress_block");
    t.observeAssistant("m2");
    const stamped = t.stamp([
      { body: "before", proposedScope: "workspace", authority: "fact", turn: 1 },
      { body: "after", proposedScope: "workspace", authority: "fact", turn: 2 },
    ]);
    expect(stamped[0]?.doNotLearnReasons).toBeUndefined();
    expect(stamped[1]?.doNotLearnReasons).toEqual(["egress_block"]);
    expect(t.snapshot().doNotLearnReasons).toEqual(["egress_block"]);
    const resumed = new TaintTracker({
      trigger: cron,
      sessionDoNotLearnReasons: t.snapshot().doNotLearnReasons ?? [],
    });
    resumed.observeAssistant("resumed");
    expect(
      resumed.stamp([
        { body: "still blocked", proposedScope: "bot", authority: "fact", turn: 1 },
      ])[0]?.doNotLearnReasons,
    ).toEqual(["egress_block"]);
  });
});
