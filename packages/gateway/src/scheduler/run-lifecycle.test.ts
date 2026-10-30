// T1: the Gateway knobs that travel with a run. `DESKMATES_MAX_TURNS` is configuration, recorded in
// `runs.config_json` and put on the `StartRunRequest` (AGENTS.md: "Every run records its full
// knob configuration").

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

let h: Harness;

// ADR-0023 decision 1: a bot override must have a price row, so the overrides below do.
const priced = (model: string) => ({
  model,
  inputPerM: 1,
  outputPerM: 1,
  cacheReadPerM: 1,
  cacheCreatePerM: 1,
  effectiveFrom: "1970-01-01T00:00:00.000Z",
});

beforeEach(async () => {
  h = await startHarness({
    maxTurns: 7,
    modelPrices: [priced("bot-override-model"), priced("bot-override-cheap")],
  });
});

afterEach(async () => {
  await h.close();
});

describe("maxTurns as a Gateway knob", () => {
  it("is recorded on the run row and handed to the sidecar", async () => {
    const { thread } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "answered",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "ok",
        },
        usage: [],
      });
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "x" },
    );
    const run = posted.json.runs[0] as RunRecord;
    expect(run.config.maxTurns).toBe(7);
    expect(run.config.browserSnapshotMode).toBe("explicit-v1");
    expect(run.config.browserCodeApproval).toBe("name-v1");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.provider.execCalls[0]?.request.maxTurns).toBe(7);
    // Issue #39 item 4: the bot's role and workspace name reach the sidecar's identity line.
    expect(h.provider.execCalls[0]?.request).toMatchObject({
      botName: "alice",
      botRole: "tester",
      workspaceName: "ws-1",
    });
    expect(h.provider.execCalls[0]?.request.browserSnapshotMode).toBeUndefined();
    expect(h.provider.execCalls[0]?.request).not.toHaveProperty("browserCodeApproval");
  });

  it("travels with a thread-less trigger too", async () => {
    h.app.deskmates.ctx.config.browserSnapshotMode = "inline-v2";
    h.app.deskmates.ctx.config.browserCodeApproval = "effects-v1";
    const { bot } = await h.seed();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "swept",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "",
        },
        usage: [],
      });
    });
    const run = h.app.deskmates.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "whk_direct",
      triggerPayload: { body: "ping" },
      config: h.app.deskmates.ctx.runConfig(),
    });
    expect(run.config.maxTurns).toBe(7);
    h.app.deskmates.ctx.config.browserSnapshotMode = "explicit-v1";
    h.app.deskmates.ctx.config.browserCodeApproval = "name-v1";
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.provider.execCalls[0]?.request.maxTurns).toBe(7);
    expect(h.provider.execCalls[0]?.request).toMatchObject({
      botRole: "tester",
      workspaceName: "ws-1",
    });
    expect(run.config.browserSnapshotMode).toBe("inline-v2");
    expect(h.provider.execCalls[0]?.request.browserSnapshotMode).toBe("inline-v2");
    // ADR-0002 amendment 5: the run row's policy, not the Gateway's current one, is sent.
    expect(run.config.browserCodeApproval).toBe("effects-v1");
    expect(h.provider.execCalls[0]?.request.browserCodeApproval).toBe("effects-v1");
  });
});

/**
 * QA-03. `defaultModel` in `runs.config_json` is the Gateway-wide knob, not the model a run with a
 * bot override actually used, and a bot's model is editable long after the run is over. Without
 * the run's own record, an exported trace names whatever the bot points at today.
 */
describe("the run's effective model is recorded on the row", () => {
  const completeRun: Parameters<Harness["provider"]["onRun"]>[0] = async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "answered",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "ok",
      },
      usage: [],
    });
  };

  async function runInThread(
    model?: string,
    cheapModel?: string,
    reasoning: { effort?: string; thinking?: unknown } = {},
  ): Promise<RunRecord> {
    const suffix = `${model ?? "default"}-${cheapModel ?? "default"}-${reasoning.effort ?? "none"}`;
    const ws = await h.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
      // Within the 32-unit workspace name bound (ADR-0034).
      name: `ws-${suffix}`.slice(0, 32),
      egressAllowlist: ["*.example.test"],
    });
    const bot = await h.api<{ bot: { id: string } }>("POST", "/api/bots", {
      name: `bot-${suffix}`,
      role: "tester",
      workspaceId: ws.json.workspace.id,
      ...(model === undefined ? {} : { model }),
      ...(cheapModel === undefined ? {} : { cheapModel }),
      ...reasoning,
    });
    const thread = await h.api<{ thread: { id: string } }>("POST", "/api/threads", {
      workspaceId: ws.json.workspace.id,
      botIds: [bot.json.bot.id],
    });
    h.provider.onRun(completeRun);
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.json.thread.id}/messages`,
      { body: "x" },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    return h.app.deskmates.ctx.runs.mustGet(run.id);
  }

  it("stamps the bot's override, not just the Gateway default", async () => {
    const run = await runInThread("bot-override-model");
    expect(run.config.model).toBe("bot-override-model");
    expect(run.config.defaultModel).toBe("test-model-default");
    expect(run.config.defaultCheapModel).toBe("test-model-cheap");
    expect(h.provider.execCalls.at(-1)?.request.model).toBe("bot-override-model");
  });

  it("stamps the bot's cheap-model override beside the main one", async () => {
    const run = await runInThread("bot-override-model", "bot-override-cheap");
    expect(run.config.cheapModel).toBe("bot-override-cheap");
    expect(run.config.defaultCheapModel).toBe("test-model-cheap");
    expect(h.provider.execCalls.at(-1)?.request.cheapModel).toBe("bot-override-cheap");
  });

  it("records the Gateway cheap model when the bot has no override", async () => {
    const run = await runInThread();
    expect(run.config.cheapModel).toBe("test-model-cheap");
    expect(run.config.defaultCheapModel).toBe("test-model-cheap");
    expect(h.provider.execCalls.at(-1)?.request.cheapModel).toBe("test-model-cheap");
  });

  it("stamps the default when the bot has no override", async () => {
    const run = await runInThread();
    expect(run.config.model).toBe("test-model-default");
    expect(h.provider.execCalls.at(-1)?.request.model).toBe("test-model-default");
  });

  it("records the reasoning knob as sdk-default and sends the sidecar no key when unset", async () => {
    const run = await runInThread();
    expect(run.config.reasoning).toEqual({
      effort: "sdk-default",
      thinking: "sdk-default",
      effortSource: "sdk-default",
      thinkingSource: "sdk-default",
    });
    const request = h.provider.execCalls.at(-1)?.request as unknown as Record<string, unknown>;
    expect("effort" in request).toBe(false);
    expect("thinking" in request).toBe(false);
  });

  it("records the bot's reasoning override and hands it to the sidecar", async () => {
    const run = await runInThread(undefined, undefined, {
      effort: "low",
      thinking: { type: "adaptive" },
    });
    expect(run.config.reasoning).toEqual({
      effort: "low",
      thinking: { type: "adaptive" },
      effortSource: "bot",
      thinkingSource: "bot",
    });
    expect(h.provider.execCalls.at(-1)?.request.effort).toBe("low");
    expect(h.provider.execCalls.at(-1)?.request.thinking).toEqual({ type: "adaptive" });
  });

  it("a per-run effort on the run's config wins over the bot's", async () => {
    const { bot } = await h.seed();
    await h.api("PATCH", `/api/bots/${bot.id}`, { effort: "xhigh" });
    h.provider.onRun(completeRun);
    const created = h.app.deskmates.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "whk_effort",
      triggerPayload: { body: "ping" },
      config: { ...h.app.deskmates.ctx.runConfig(), effort: "low" },
    });
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(created.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(created.id).config.reasoning).toMatchObject({
      effort: "low",
      effortSource: "run",
      thinking: "sdk-default",
    });
    expect(h.provider.execCalls.at(-1)?.request.effort).toBe("low");
  });

  it("a thread-less trigger records it too", async () => {
    const { bot } = await h.seed();
    h.provider.onRun(completeRun);
    const created = h.app.deskmates.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "whk_model",
      triggerPayload: { body: "ping" },
      config: h.app.deskmates.ctx.runConfig(),
    });
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(created.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.app.deskmates.ctx.runs.mustGet(created.id).config.model).toBe("test-model-default");
  });

  it("a resumed run keeps its original model and snapshot mode", async () => {
    h.app.deskmates.ctx.config.browserSnapshotMode = "inline-v2";
    const { bot, thread } = await h.seed();
    // The first process defers on an L2 call; the second one resumes it.
    let attempt = 0;
    h.provider.onRun(async (req, gw) => {
      attempt += 1;
      if (attempt === 1) {
        await gw.post("approvals", {
          type: "approval_request",
          runId: req.runId,
          approvalId: "apr_model_test",
          action: {
            toolName: "Bash",
            input: { command: "git push origin main" },
            argumentSummary: "git push origin main",
            argumentPattern: "git push*",
          },
          riskLevel: "L2",
          toolUseId: "toolu_1",
        });
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-1",
          pendingApprovalId: "apr_model_test",
          pendingToolUseId: "toolu_1",
          usage: [],
        });
        return;
      }
      await completeRun(req, gw);
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "push it" },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      3000,
      "parked",
    );
    const stamped = h.app.deskmates.ctx.runs.mustGet(run.id).config.model;
    expect(stamped).toBe("test-model-default");

    expect(h.provider.execCalls[0]?.request.browserSnapshotMode).toBe("inline-v2");
    h.app.deskmates.ctx.config.browserSnapshotMode = "explicit-v1";
    // The bot is re-pointed while the run sits waiting for a human.
    h.app.deskmates.ctx.db
      .prepare("UPDATE bots SET model = ? WHERE id = ?")
      .run("re-pointed-model", bot.id);
    await h.api("POST", "/api/approvals/apr_model_test/decide", {
      decision: "allow_once",
      decidedBy: "human:qa",
    });
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).attempt === 2, 3000, "resumed");

    expect(h.app.deskmates.ctx.runs.mustGet(run.id).config.model).toBe(stamped);
    expect(h.provider.execCalls.at(-1)?.request.model).toBe(stamped);
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).config.browserSnapshotMode).toBe("inline-v2");
    expect(h.provider.execCalls.at(-1)?.request.browserSnapshotMode).toBe("inline-v2");
  });

  it("a resumed run in a group keeps the group norm flag its first attempt had", async () => {
    const { bot, thread } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const peer = ctx.bots.create({ name: "peer", role: "reviewer", workspaceId: bot.workspaceId });
    ctx.threads.addMember(thread.id, peer.id);
    let attempt = 0;
    h.provider.onRun(async (req, gw) => {
      // The approval card wakes the peer; it has nothing to do here.
      if (req.botId !== bot.id) return completeRun(req, gw);
      attempt += 1;
      if (attempt === 1) {
        await gw.post("approvals", {
          type: "approval_request",
          runId: req.runId,
          approvalId: "apr_group_norm",
          action: {
            toolName: "Bash",
            input: { command: "git push origin main" },
            argumentSummary: "git push origin main",
            argumentPattern: "git push*",
          },
          riskLevel: "L2",
          toolUseId: "toolu_1",
        });
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-1",
          pendingApprovalId: "apr_group_norm",
          pendingToolUseId: "toolu_1",
          usage: [],
        });
        return;
      }
      await completeRun(req, gw);
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: `@${bot.name} push it` },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(() => ctx.runs.mustGet(run.id).status === "waiting_approval", 3000, "parked");
    expect(ctx.runs.mustGet(run.id).config.groupGuidance).toBe("owner-v1");
    await h.api("POST", "/api/approvals/apr_group_norm/decide", {
      decision: "allow_once",
      decidedBy: "human:qa",
    });
    await waitFor(() => ctx.runs.mustGet(run.id).attempt === 2, 3000, "resumed");
    const requests = h.provider.execCalls
      .map((call) => call.request)
      .filter((request) => request.runId === run.id);
    expect(requests.map((request) => request.trigger.kind)).toEqual(["thread_message", "approval"]);
    expect(requests.map((request) => request.groupGuidance)).toEqual(["owner-v1", "owner-v1"]);
  });

  it("a resumed run keeps the cheap model its first attempt ran on", async () => {
    const { bot, thread } = await h.seed();
    let attempt = 0;
    h.provider.onRun(async (req, gw) => {
      attempt += 1;
      if (attempt === 1) {
        await gw.post("approvals", {
          type: "approval_request",
          runId: req.runId,
          approvalId: "apr_cheap_test",
          action: {
            toolName: "Bash",
            input: { command: "git push origin main" },
            argumentSummary: "git push origin main",
            argumentPattern: "git push*",
          },
          riskLevel: "L2",
          toolUseId: "toolu_1",
        });
        await gw.post("ended", {
          type: "run_ended",
          runId: req.runId,
          outcome: "deferred",
          sdkSessionId: "sess-1",
          pendingApprovalId: "apr_cheap_test",
          pendingToolUseId: "toolu_1",
          usage: [],
        });
        return;
      }
      await completeRun(req, gw);
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "push it" },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      3000,
      "parked",
    );
    const parked = h.app.deskmates.ctx.runs.mustGet(run.id).config;
    expect(parked.model).toBe("test-model-default");
    expect(parked.cheapModel).toBe("test-model-cheap");

    // Both of the bot's models are changed while the run sits waiting for a human.
    h.app.deskmates.ctx.db
      .prepare("UPDATE bots SET model = ?, cheap_model = ? WHERE id = ?")
      .run("re-pointed-model", "re-pointed-cheap", bot.id);
    await h.api("POST", "/api/approvals/apr_cheap_test/decide", {
      decision: "allow_once",
      decidedBy: "human:qa",
    });
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).attempt === 2, 3000, "resumed");

    const resumed = h.provider.execCalls.at(-1)?.request;
    expect(resumed?.model).toBe(parked.model);
    expect(resumed?.cheapModel).toBe(parked.cheapModel);
    const after = h.app.deskmates.ctx.runs.mustGet(run.id).config;
    expect(after.model).toBe(parked.model);
    expect(after.cheapModel).toBe(parked.cheapModel);
  });
});

/**
 * M3 context plan, Phase 1: the context events are accepted into the ledger, and the facts only
 * the sidecar knows at start (the system prompt hash, the CLI's context window setting) land in
 * `runs.config_json` from RunEnded.
 */
describe("context observability from the sidecar", () => {
  const HASH = "ab".repeat(32);

  async function runWith(ended: Record<string, unknown>): Promise<RunRecord> {
    const { thread } = await h.seed();
    const stored: number[] = [];
    h.provider.onRun(async (req, gw) => {
      const res = await gw.post("events", [
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 1,
          kind: "turn_usage",
          payload: {
            model: "m",
            turn: 1,
            inputTokens: 10,
            outputTokens: 2,
            cacheReadTokens: 90,
            cacheCreateTokens: 0,
          },
          ts: "2026-09-29T10:00:00.000Z",
        },
        {
          type: "event",
          runId: req.runId,
          attempt: 1,
          seq: 2,
          kind: "compact_boundary",
          payload: { trigger: "auto", preTokens: 150000 },
          ts: "2026-09-29T10:00:01.000Z",
        },
      ]);
      stored.push(res.status);
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "completed",
        summary: {
          done: "answered",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "ok",
        },
        usage: [],
        ...ended,
      });
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "x" },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    expect(stored).toEqual([200]);
    return h.app.deskmates.ctx.runs.mustGet(run.id);
  }

  it("stores turn_usage and compact_boundary events and merges the hash and window", async () => {
    const run = await runWith({
      systemPromptSha256: HASH,
      systemPromptStaticSha256: "f".repeat(64),
      maxContextTokens: 180000,
    });
    const kinds = h.app.deskmates.ctx.events.list(run.id).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["turn_usage", "compact_boundary"]));
    expect(run.config.systemPromptSha256).toBe(HASH);
    // ADR-0023 amendment 5: the static part's hash is a knob of the same kind.
    expect(run.config.systemPromptStaticSha256).toBe("f".repeat(64));
    expect(run.config.claudeCodeMaxContextTokens).toBe(180000);
  });

  it("ignores malformed values instead of failing the run", async () => {
    const run = await runWith({
      systemPromptSha256: "not-a-hash",
      systemPromptStaticSha256: "F".repeat(64),
      maxContextTokens: -1,
    });
    expect(run.config).not.toHaveProperty("systemPromptSha256");
    expect(run.config).not.toHaveProperty("systemPromptStaticSha256");
    expect(run.config).not.toHaveProperty("claudeCodeMaxContextTokens");
  });
});

/**
 * Issue #88, ADR-0038: the working-directory knob (`DESKMATES_BOT_WORKDIR`) defaults to per-bot;
 * shared is the other value. The run row records the mode it was created under, and every process of that run (first start, thread-less
 * trigger, approval resume) gets the same mode, whatever the Gateway is configured with later.
 */
describe("the bot working-directory knob travels with the run", () => {
  const finish: Parameters<Harness["provider"]["onRun"]>[0] = async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "ok",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "ok",
      },
      usage: [],
    });
  };

  it("records per-bot by default and sends it (ADR-0038 decision 1)", async () => {
    // A fresh harness leaves DESKMATES_BOT_WORKDIR unset.
    const { thread } = await h.seed();
    h.provider.onRun(finish);
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "x" },
    );
    const run = posted.json.runs[0] as RunRecord;
    expect(run.config.botWorkdir).toBe("per-bot");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.provider.execCalls[0]?.request.workdirMode).toBe("per-bot");
  });

  it("records shared when configured and sends no mode, so the sidecar keeps /work", async () => {
    h.app.deskmates.ctx.config.botWorkdir = "shared";
    const { thread } = await h.seed();
    h.provider.onRun(finish);
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "x" },
    );
    const run = posted.json.runs[0] as RunRecord;
    expect(run.config.botWorkdir).toBe("shared");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.provider.execCalls[0]?.request).not.toHaveProperty("workdirMode");
  });

  it("sends per-bot to a thread run and to a thread-less trigger created under it", async () => {
    h.app.deskmates.ctx.config.botWorkdir = "per-bot";
    const { bot, thread } = await h.seed();
    h.provider.onRun(finish);
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "x" },
    );
    const chat = posted.json.runs[0] as RunRecord;
    expect(chat.config.botWorkdir).toBe("per-bot");
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(chat.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.provider.execCalls[0]?.request.workdirMode).toBe("per-bot");

    const cron = h.app.deskmates.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: "whk_workdir",
      triggerPayload: { body: "ping" },
      config: h.app.deskmates.ctx.runConfig(),
    });
    // The row decides, not the Gateway's current configuration.
    h.app.deskmates.ctx.config.botWorkdir = "shared";
    h.app.deskmates.scheduler.kick();
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(cron.id).status === "succeeded",
      3000,
      "run",
    );
    expect(h.provider.execCalls.at(-1)?.request.workdirMode).toBe("per-bot");
  });

  it("a resumed run keeps the mode its first attempt had", async () => {
    h.app.deskmates.ctx.config.botWorkdir = "per-bot";
    const { thread } = await h.seed();
    let attempt = 0;
    h.provider.onRun(async (req, gw) => {
      attempt += 1;
      if (attempt > 1) return finish(req, gw);
      await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr_workdir",
        action: {
          toolName: "Bash",
          input: { command: "git push origin main" },
          argumentSummary: "git push origin main",
          argumentPattern: "git push*",
        },
        riskLevel: "L2",
        toolUseId: "toolu_1",
      });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-1",
        pendingApprovalId: "apr_workdir",
        pendingToolUseId: "toolu_1",
        usage: [],
      });
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "push it" },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      3000,
      "parked",
    );
    h.app.deskmates.ctx.config.botWorkdir = "shared";
    await h.api("POST", "/api/approvals/apr_workdir/decide", {
      decision: "allow_once",
      decidedBy: "human:qa",
    });
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).attempt === 2, 3000, "resumed");
    expect(h.provider.execCalls.at(-1)?.request.workdirMode).toBe("per-bot");
  });
});

/**
 * ADR-0036 decisions 3 and 6: a workspace's stored settings win over the Gateway knob, are frozen
 * on the run's first process and sent unchanged on a resume; the lane notice names the bot's live
 * run on its other lane.
 */
describe("workspace working-directory settings freeze at first start", () => {
  const finish: Parameters<Harness["provider"]["onRun"]>[0] = async (req, gw) => {
    await gw.post("ended", {
      type: "run_ended",
      runId: req.runId,
      outcome: "completed",
      summary: {
        done: "ok",
        filesChanged: [],
        sitesVisited: [],
        pendingApprovals: [],
        memorySuggestions: [],
        reply: "ok",
      },
      usage: [],
    });
  };

  it("sends the workspace's mode, frozen across a resume", async () => {
    h.app.deskmates.ctx.config.botWorkdir = "shared";
    const { workspace, thread } = await h.seed();
    h.app.deskmates.ctx.workdir.set(workspace.id, { mode: "per-bot" }, "user:qa");
    let attempt = 0;
    h.provider.onRun(async (req, gw) => {
      attempt += 1;
      if (attempt > 1) return finish(req, gw);
      await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: "apr_worktree",
        action: {
          toolName: "Bash",
          input: { command: "git push origin main" },
          argumentSummary: "git push origin main",
          argumentPattern: "git push*",
        },
        riskLevel: "L2",
        toolUseId: "toolu_1",
      });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-1",
        pendingApprovalId: "apr_worktree",
        pendingToolUseId: "toolu_1",
        usage: [],
      });
    });
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "push it" },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "waiting_approval",
      3000,
      "parked",
    );
    expect(h.provider.execCalls[0]?.request).toMatchObject({ workdirMode: "per-bot" });
    // ADR-0038 decision 7: no worktree repository is ever sent.
    expect(h.provider.execCalls[0]?.request).not.toHaveProperty("worktreeRepo");
    expect(h.provider.execCalls[0]?.request).not.toHaveProperty("otherLaneRun");
    expect(h.app.deskmates.ctx.runs.mustGet(run.id).config).toMatchObject({
      botWorkdir: "per-bot",
      botWorkdirSource: "workspace",
      laneNotice: false,
      workdirVersion: 1,
    });
    h.app.deskmates.ctx.workdir.set(workspace.id, { mode: null }, "user:qa");
    await h.api("POST", "/api/approvals/apr_worktree/decide", {
      decision: "allow_once",
      decidedBy: "human:qa",
    });
    await waitFor(() => h.app.deskmates.ctx.runs.mustGet(run.id).attempt === 2, 3000, "resumed");
    expect(h.provider.execCalls.at(-1)?.request).toMatchObject({ workdirMode: "per-bot" });
  });

  it("lane notice: names the bot's live background run to its interactive run", async () => {
    h.app.deskmates.ctx.config.botWorkdir = "shared";
    const { workspace, bot, thread } = await h.seed();
    h.app.deskmates.ctx.workdir.set(workspace.id, { laneNotice: true }, "user:qa");
    h.provider.onRun(finish);
    const background = h.app.deskmates.ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "cron_lane",
      triggerPayload: { prompt: "nightly" },
      config: h.app.deskmates.ctx.runConfig(),
    });
    h.app.deskmates.ctx.db
      .prepare("UPDATE runs SET status = 'running', started_at = ? WHERE id = ?")
      .run("2026-10-14T08:00:00.000Z", background.id);
    const posted = await h.api<{ runs: RunRecord[] }>(
      "POST",
      `/api/threads/${thread.id}/messages`,
      { body: "x" },
    );
    const run = posted.json.runs[0] as RunRecord;
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(run.id).status === "succeeded",
      3000,
      "run",
    );
    const request = h.provider.execCalls.find((c) => c.request.runId === run.id)?.request;
    expect(request?.otherLaneRun).toEqual({
      runId: background.id,
      lane: "background",
      triggerKind: "cron",
      startedAt: "2026-10-14T08:00:00.000Z",
    });
    // The lane notice alone changes no directory.
    expect(request).not.toHaveProperty("workdirMode");
  });
});
