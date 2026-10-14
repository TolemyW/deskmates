// T1 for ADR-0024 amendment 1: Bot creation owns the canonical inbox and schedules the real
// welcome run; pins are workspace-shared presentation state and never a routing input.

import type {
  BotDefinition,
  RunUsage,
  Thread,
  ThreadMessage,
  ThreadSummary,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";

describe("Bot inbox welcome lifecycle", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("creates the canonical private chat and queues a normally accounted model run", async () => {
    const { workspace } = await h.seed();
    h.provider.onRun(async (request, gateway) => {
      expect(request.trigger).toMatchObject({ kind: "welcome" });
      expect(request.threadId).toBeDefined();
      await gateway.post("ended", {
        type: "run_ended",
        runId: request.runId,
        outcome: "completed",
        sdkSessionId: "welcome-session",
        summary: {
          done: "introduced itself",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "Hi, I am Scout. How can I help?",
        },
        usage: [
          {
            model: "test-model-default",
            inputTokens: 12,
            outputTokens: 9,
            cacheReadTokens: 0,
            cacheCreateTokens: 0,
          },
        ],
      });
    });

    const created = await h.api<{
      bot: BotDefinition;
      privateChat: Thread;
      welcomeRun: RunRecord;
    }>("POST", "/api/bots", {
      name: "scout",
      role: "researcher",
      workspaceId: workspace.id,
    });

    expect(created.status).toBe(201);
    expect(created.json.privateChat.workspaceId).toBe(workspace.id);
    expect(created.json.welcomeRun).toMatchObject({
      botId: created.json.bot.id,
      threadId: created.json.privateChat.id,
      triggerKind: "welcome",
      status: "queued",
    });
    expect(created.json.welcomeRun.config).toMatchObject({ welcomeVersion: 1 });

    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(created.json.welcomeRun.id).status === "succeeded",
      3000,
      "welcome reply",
    );
    const listed = await h.api<{ threads: ThreadSummary[] }>(
      "GET",
      `/api/threads?workspaceId=${workspace.id}`,
    );
    expect(
      listed.json.threads.find((thread) => thread.id === created.json.privateChat.id),
    ).toMatchObject({
      privateChatBotId: created.json.bot.id,
      memberIds: [created.json.bot.id],
    });
    const messages = await h.api<{ messages: ThreadMessage[] }>(
      "GET",
      `/api/threads/${created.json.privateChat.id}/messages`,
    );
    expect(messages.json.messages.at(-1)?.body).toBe("Hi, I am Scout. How can I help?");
    const usage = h.app.deskmates.ctx.usage.list(created.json.welcomeRun.id) as RunUsage[];
    expect(usage[0]).toMatchObject({ inputTokens: 12, outputTokens: 9 });
  });

  it("lets a failed welcome retry once the previous attempt is terminal", async () => {
    const { workspace } = await h.seed();
    const created = await h.api<{
      bot: BotDefinition;
      privateChat: Thread;
      welcomeRun: RunRecord;
    }>("POST", "/api/bots", { name: "writer", role: "writer", workspaceId: workspace.id });
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(created.json.welcomeRun.id).status === "failed",
      3000,
      "failed welcome",
    );

    h.provider.onRun(async (request, gateway) => {
      await gateway.post("ended", {
        type: "run_ended",
        runId: request.runId,
        outcome: "completed",
        summary: {
          done: "retried",
          filesChanged: [],
          sitesVisited: [],
          pendingApprovals: [],
          memorySuggestions: [],
          reply: "Hi on retry",
        },
        usage: [],
      });
    });
    const retry = await h.api<{ run: RunRecord; thread: Thread }>(
      "POST",
      `/api/bots/${created.json.bot.id}/welcome`,
      {},
    );
    expect(retry.status).toBe(202);
    expect(retry.json.thread.id).toBe(created.json.privateChat.id);
    expect(retry.json.run.id).not.toBe(created.json.welcomeRun.id);
    await waitFor(
      () => h.app.deskmates.ctx.runs.mustGet(retry.json.run.id).status === "succeeded",
      3000,
      "retried welcome",
    );
  });

  // ADR-0024 amendment 2, decision 11 (issue #122).
  describe("welcome delivery", () => {
    type Created = { bot: BotDefinition; privateChat: Thread; welcomeRun: RunRecord };
    type Listed = { runs: (RunRecord & { welcomeDelivery?: string })[] };

    function endWelcome(
      opts: { post?: string; outcome?: "completed" | "failed"; reply?: string } = {},
    ): Parameters<Harness["provider"]["onRun"]>[0] {
      return async (request, gateway) => {
        if (opts.post !== undefined)
          await gateway.post("messages", {
            type: "post_message",
            runId: request.runId,
            tool: "thread_post",
            body: opts.post,
          });
        await gateway.post("ended", {
          type: "run_ended",
          runId: request.runId,
          outcome: opts.outcome ?? "completed",
          summary: {
            done: "welcome",
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
            reply: opts.reply ?? "",
          },
          usage: [],
        });
      };
    }

    async function createSettled(status: string): Promise<Created> {
      const { workspace } = await h.seed();
      const created = await h.api<Created>("POST", "/api/bots", {
        name: "greeter",
        role: "host",
        workspaceId: workspace.id,
      });
      await waitFor(
        () => h.app.deskmates.ctx.runs.mustGet(created.json.welcomeRun.id).status === status,
        3000,
        `welcome ${status}`,
      );
      return created.json;
    }

    const welcomeRuns = (botId: string) =>
      h.app.deskmates.ctx.runs.list({ botId: botId as BotDefinition["id"] });

    it("treats a silent welcome that greeted through thread_post as delivered", async () => {
      h.provider.onRun(endWelcome({ post: "Hello from greeter" }));
      const created = await createSettled("silent");

      const listed = await h.api<Listed>("GET", `/api/runs?threadId=${created.privateChat.id}`);
      expect(listed.json.runs.find((r) => r.id === created.welcomeRun.id)).toMatchObject({
        status: "silent",
        welcomeDelivery: "delivered",
      });
      const detail = await h.api<{ run: { welcomeDelivery?: string } }>(
        "GET",
        `/api/runs/${created.welcomeRun.id}`,
      );
      expect(detail.json.run.welcomeDelivery).toBe("delivered");

      const retries = await Promise.all([
        h.api("POST", `/api/bots/${created.bot.id}/welcome`, {}),
        h.api("POST", `/api/bots/${created.bot.id}/welcome`, {}),
      ]);
      expect(retries.map((r) => r.status)).toEqual([409, 409]);
      expect(welcomeRuns(created.bot.id)).toHaveLength(1);
      const messages = await h.api<{ messages: ThreadMessage[] }>(
        "GET",
        `/api/threads/${created.privateChat.id}/messages`,
      );
      expect(messages.json.messages.filter((m) => m.authorKind === "bot")).toHaveLength(1);
    });

    it("keeps an empty silent welcome retryable, once per concurrent pair", async () => {
      h.provider.onRun(endWelcome());
      const created = await createSettled("silent");
      const listed = await h.api<Listed>("GET", `/api/runs?threadId=${created.privateChat.id}`);
      expect(listed.json.runs[0]?.welcomeDelivery).toBe("undelivered");

      h.provider.onRun(endWelcome({ reply: "Hello again" }));
      const retries = await Promise.all([
        h.api<{ run: RunRecord }>("POST", `/api/bots/${created.bot.id}/welcome`, {}),
        h.api<{ run: RunRecord }>("POST", `/api/bots/${created.bot.id}/welcome`, {}),
      ]);
      expect(retries.map((r) => r.status).sort()).toEqual([202, 409]);
      expect(welcomeRuns(created.bot.id)).toHaveLength(2);
      const retried = retries.find((r) => r.status === 202)?.json.run.id as RunRecord["id"];
      await waitFor(
        () => h.app.deskmates.ctx.runs.mustGet(retried).status === "succeeded",
        3000,
        "retried welcome",
      );
      const again = await h.api("POST", `/api/bots/${created.bot.id}/welcome`, {});
      expect(again.status).toBe(409);
    });

    it("reports a failed welcome that already posted as partial and does not retry it", async () => {
      h.provider.onRun(endWelcome({ post: "Hi, I started", outcome: "failed" }));
      const created = await createSettled("failed");
      const listed = await h.api<Listed>("GET", `/api/runs?threadId=${created.privateChat.id}`);
      expect(listed.json.runs[0]).toMatchObject({
        status: "failed",
        welcomeDelivery: "partial",
      });
      const retry = await h.api("POST", `/api/bots/${created.bot.id}/welcome`, {});
      expect(retry.status).toBe(409);
      expect(welcomeRuns(created.bot.id)).toHaveLength(1);
    });
  });

  it("resolves an Admin one-Bot create request to the canonical chat", async () => {
    const { workspace, bot, thread } = await h.seed();
    const first = await h.api<{ thread: Thread }>("POST", "/api/threads", {
      workspaceId: workspace.id,
      botIds: [bot.id],
    });
    const second = await h.api<{ thread: Thread }>("POST", "/api/threads", {
      workspaceId: workspace.id,
      botIds: [bot.id],
    });
    expect(first.status).toBe(200);
    expect(first.json.thread.id).toBe(thread.id);
    expect(second.json.thread.id).toBe(thread.id);
    expect(h.app.deskmates.ctx.threads.list(workspace.id)).toHaveLength(1);
  });
});

describe("workspace-shared chat pins", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it("persists ordered pins without creating messages or runs, and unpins idempotently", async () => {
    const { workspace, bot, thread } = await h.seed();
    const second = h.app.deskmates.ctx.bots.create({
      name: "bob",
      role: "helper",
      workspaceId: workspace.id,
    });
    const group = h.app.deskmates.ctx.threads.create({
      workspaceId: workspace.id,
      botIds: [bot.id, second.id],
      title: "Team",
    });

    expect((await h.api("POST", `/api/threads/${thread.id}/pin`, {})).status).toBe(200);
    expect((await h.api("POST", `/api/threads/${group.id}/pin`, {})).status).toBe(200);
    // Repeating the row action preserves its position instead of consuming another slot.
    expect((await h.api("POST", `/api/threads/${thread.id}/pin`, {})).status).toBe(200);

    const listed = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    expect(
      listed.json.threads
        .filter((item) => item.pinPosition !== undefined)
        .sort((a, b) => (a.pinPosition ?? 0) - (b.pinPosition ?? 0))
        .map((item) => [item.id, item.pinPosition]),
    ).toEqual([
      [thread.id, 1],
      [group.id, 2],
    ]);
    expect(h.app.deskmates.ctx.runs.list()).toEqual([]);
    expect(h.app.deskmates.ctx.messages.list(thread.id)).toEqual([]);

    expect((await h.api("DELETE", `/api/threads/${thread.id}/pin`)).status).toBe(200);
    expect((await h.api("DELETE", `/api/threads/${thread.id}/pin`)).status).toBe(200);
    const after = await h.api<{ threads: ThreadSummary[] }>("GET", "/api/threads");
    expect(after.json.threads.find((item) => item.id === thread.id)?.pinPosition).toBeUndefined();
    expect(after.json.threads.find((item) => item.id === group.id)?.pinPosition).toBe(2);
  });

  it("refuses a missing or bot-to-bot thread as a display pin target", async () => {
    const { workspace, bot } = await h.seed();
    const bus = h.app.deskmates.ctx.threads.create({
      workspaceId: workspace.id,
      botIds: [bot.id],
      kind: "bus",
    });
    expect((await h.api("POST", "/api/threads/missing/pin", {})).status).toBe(404);
    expect((await h.api("POST", `/api/threads/${bus.id}/pin`, {})).status).toBe(400);
  });
});
