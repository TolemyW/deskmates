// T1: the cron runner against a live Gateway with the fake provider (test strategy §4.2
// "cron overlap", §5 "clock going backwards"). Every case drives `tick` with an injected clock;
// the minute timer itself is not started in tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BotDefinition,
  RUN_ERROR_CRON_MISFIRE,
  type StartRunRequest,
  type Workspace,
} from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import { sidecarToolsFor } from "../scheduler/sidecar-tools.js";
import type { SidecarScript } from "../test-support/fake-provider.js";
import { type Harness, nextTurn, openSse, startHarness, waitFor } from "../test-support/harness.js";

const MINUTE_10_05 = new Date("2026-09-22T10:05:00.000Z");
const MINUTE_10_06 = new Date("2026-09-22T10:06:00.000Z");
const MINUTE_10_10 = new Date("2026-09-22T10:10:00.000Z");

/** A sidecar that reports a completed run with a reply — which a run with no thread keeps. */
const FINISH: SidecarScript = async (req, gw) => {
  const res = await gw.post("ended", {
    type: "run_ended",
    runId: req.runId,
    outcome: "completed",
    usage: [],
    summary: {
      done: "swept the queue",
      filesChanged: [],
      sitesVisited: [],
      pendingApprovals: [],
      memorySuggestions: [],
      reply: "nothing to report",
    },
  });
  if (res.status !== 200) throw new Error(`ended returned ${res.status}`);
  return undefined;
};

let h: Harness;

async function seedCronBot(
  harness: Harness,
  cron: { schedule: string; prompt: string }[] = [
    { schedule: "*/5 * * * *", prompt: "check tickets" },
  ],
): Promise<BotDefinition> {
  const ws = await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
    defaultBot: false,
    name: "ws-cron",
  });
  return harness.app.deskmates.ctx.bots.create({
    name: "cronbot",
    role: "scheduled",
    workspaceId: ws.json.workspace.id,
    cron,
  });
}

function runsOf(harness: Harness, bot: BotDefinition): RunRecord[] {
  return harness.app.deskmates.ctx.runs.list({ botId: bot.id });
}

beforeEach(async () => {
  h = await startHarness({ cronTimeZone: "UTC" });
  h.provider.onRun(FINISH);
});

afterEach(async () => {
  await h.close();
});

describe("cron runner (design v0.3 §3.4)", () => {
  it("creates one queued background run before any exec, then starts it with a cron trigger", async () => {
    const bot = await seedCronBot(h);
    const started: StartRunRequest[] = [];
    h.provider.onRun(async (req, gw) => {
      started.push(req);
      return FINISH(req, gw);
    });

    h.app.deskmates.cron.tick(MINUTE_10_05);

    // Every trigger creates a run row first: the row is there and no sidecar has been exec'd.
    const runs = runsOf(h, bot);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      lane: "background",
      triggerKind: "cron",
      status: "queued",
      triggerRef: "cron:0:2026-09-22T10:05:00.000Z",
    });
    expect(runs[0]?.triggerPayload).toEqual({
      prompt: "check tickets",
      schedule: "*/5 * * * *",
      entry: 0,
    });
    expect(runs[0]?.threadId).toBeUndefined();
    expect(h.provider.execCalls).toHaveLength(0);

    await waitFor(() => started.length === 1, 3000, "the cron run to be exec'd");
    await h.app.deskmates.scheduler.drain();
    const request = started[0] as StartRunRequest;
    expect(request.trigger).toEqual({ kind: "cron", prompt: "check tickets" });
    expect(request.tools).toEqual(sidecarToolsFor(false, (runs[0] as RunRecord).config));
    expect(request.threadId).toBeUndefined();
    expect(request.sdkSessionId).toBeUndefined();
    expect(request.botName).toBe("cronbot");

    // A run with no thread has nowhere to post its reply; it ends succeeded and keeps it.
    const ended = runsOf(h, bot)[0] as RunRecord;
    expect(ended.status).toBe("succeeded");
    expect(ended.summary?.reply).toBe("nothing to report");
  });

  it("publishes the queued run_status frame when it fires", async () => {
    const bot = await seedCronBot(h);
    const sse = await openSse(h.baseUrl);
    try {
      h.app.deskmates.cron.tick(MINUTE_10_05);
      const runId = runsOf(h, bot)[0]?.id;
      await waitFor(
        () =>
          sse.events.some(
            (e) => e.type === "run_status" && e.run.id === runId && e.run.status === "queued",
          ),
        3000,
        "a queued run_status frame for the cron run",
      );
    } finally {
      sse.close();
    }
  });

  it("start() fires the minute the Gateway starts in, then ticks on the next boundary", async () => {
    // A minute ahead of the real clock, so run tokens minted at the fake time stay valid.
    const startMinute = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
    const at = (t: number) => `${new Date(t).getUTCMinutes()} ${new Date(t).getUTCHours()} * * *`;
    const bot = await seedCronBot(h, [
      { schedule: at(startMinute), prompt: "the start minute" },
      { schedule: at(startMinute + 60_000), prompt: "the next minute" },
    ]);
    const { cron } = h.app.deskmates;
    vi.useFakeTimers({
      now: startMinute + 20_000,
      toFake: ["Date", "setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    try {
      cron.start();
      expect(runsOf(h, bot).map((r) => r.triggerRef)).toEqual([
        `cron:0:${new Date(startMinute).toISOString()}`,
      ]);
      cron.start();
      vi.advanceTimersByTime(39_000);
      expect(runsOf(h, bot)).toHaveLength(1);
      vi.advanceTimersByTime(1_000);
      expect(runsOf(h, bot).map((r) => r.triggerRef)).toContain(
        `cron:1:${new Date(startMinute + 60_000).toISOString()}`,
      );
      expect(runsOf(h, bot)).toHaveLength(2);
      cron.stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      cron.stop();
      vi.useRealTimers();
    }
    await waitFor(
      () => runsOf(h, bot).every((r) => r.status === "succeeded"),
      3000,
      "both runs to end",
    );
  });

  it("one entry that cannot fire does not cost the later bots their minute", async () => {
    const first = await seedCronBot(h);
    const second = h.app.deskmates.ctx.bots.create({
      name: "cronbot-2",
      role: "scheduled",
      workspaceId: first.workspaceId,
      cron: [{ schedule: "*/5 * * * *", prompt: "check tickets" }],
    });
    // The tick visits bots in `created_at, id` order; two bots created in the same millisecond
    // tie on the timestamp and fall back to their random ids, so fail whichever comes first.
    const [earlier, later] = h.app.deskmates.ctx.bots.list(first.workspaceId) as [
      BotDefinition,
      BotDefinition,
    ];
    expect([earlier.id, later.id].sort()).toEqual([first.id, second.id].sort());
    const { runs } = h.app.deskmates.ctx;
    vi.spyOn(runs, "create").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY: database is locked");
    });
    try {
      h.app.deskmates.cron.tick(MINUTE_10_05);
    } finally {
      vi.restoreAllMocks();
    }
    expect(runsOf(h, earlier)).toHaveLength(0);
    expect(runsOf(h, later)).toHaveLength(1);
    await h.app.deskmates.scheduler.drain();
  });

  it("does not fire on a minute the schedule misses", async () => {
    const bot = await seedCronBot(h);
    h.app.deskmates.cron.tick(MINUTE_10_06);
    expect(runsOf(h, bot)).toHaveLength(0);
  });

  it("is idempotent: the same minute twice, and a clock that went backwards, fire once", async () => {
    const bot = await seedCronBot(h);
    h.app.deskmates.cron.tick(MINUTE_10_05);
    h.app.deskmates.cron.tick(MINUTE_10_05);
    expect(runsOf(h, bot)).toHaveLength(1);
    await waitFor(() => runsOf(h, bot)[0]?.status === "succeeded", 3000, "the 10:05 run to end");

    h.app.deskmates.cron.tick(MINUTE_10_10);
    expect(runsOf(h, bot)).toHaveLength(2);
    await waitFor(
      () => runsOf(h, bot).every((r) => r.status === "succeeded"),
      3000,
      "both runs to end",
    );

    // The clock goes backwards: 10:05 has already fired and must not fire again.
    h.app.deskmates.cron.tick(MINUTE_10_05);
    expect(runsOf(h, bot)).toHaveLength(2);
  });

  it("skips the round and logs it when the previous one has not finished", async () => {
    const bot = await seedCronBot(h);
    let release: (() => void) | undefined;
    h.provider.onRun(
      async () =>
        new Promise((resolve) => {
          release = () => resolve(undefined);
        }),
    );

    h.app.deskmates.cron.tick(MINUTE_10_05);
    await waitFor(() => runsOf(h, bot)[0]?.status === "running", 3000, "the run to start");
    const first = runsOf(h, bot)[0] as RunRecord;

    h.app.deskmates.cron.tick(MINUTE_10_10);
    await nextTurn();

    expect(runsOf(h, bot)).toHaveLength(1);
    const skipped = h.app.deskmates.ctx.events
      .list(first.id)
      .filter((e) => e.kind === "log" && e.payload.skipped === true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload).toMatchObject({
      source: "cron",
      skipped: true,
      entry: 0,
      schedule: "*/5 * * * *",
      minute: "2026-09-22T10:10:00.000Z",
    });

    release?.();
    await h.app.deskmates.scheduler.drain();
  });

  it("skips the round while the previous one is parked on an approval", async () => {
    // A parked round holds no lane, but it has not finished: firing the next minute would create
    // a second run and ask the human the same question twice (design v0.3 §3.4).
    const bot = await seedCronBot(h);
    h.provider.onRun(async (req, gw) => {
      const res = await gw.post("approvals", {
        type: "approval_request",
        runId: req.runId,
        approvalId: `apr-${req.runId}`,
        action: {
          toolName: "Bash",
          input: { command: "rm -rf /var/queue" },
          argumentSummary: "rm -rf /var/queue",
        },
        riskLevel: "L2",
        toolUseId: "toolu_1",
      });
      // Nobody is online in this harness, so the broker answers `defer` and the run parks.
      expect(await res.json()).toMatchObject({ decision: "defer" });
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "deferred",
        sdkSessionId: "sess-cron",
        usage: [],
        pendingApprovalId: `apr-${req.runId}`,
        pendingToolUseId: "toolu_1",
      });
      return undefined;
    });

    h.app.deskmates.cron.tick(MINUTE_10_05);
    await waitFor(
      () => runsOf(h, bot)[0]?.status === "waiting_approval",
      3000,
      "the first round to park",
    );
    const parked = runsOf(h, bot)[0] as RunRecord;

    h.app.deskmates.cron.tick(MINUTE_10_10);
    await nextTurn();

    expect(runsOf(h, bot)).toHaveLength(1);
    expect(runsOf(h, bot)[0]?.status).toBe("waiting_approval");
    const skipped = h.app.deskmates.ctx.events
      .list(parked.id)
      .filter((e) => e.kind === "log" && e.payload.skipped === true);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.payload).toMatchObject({
      source: "cron",
      skipped: true,
      entry: 0,
      minute: "2026-09-22T10:10:00.000Z",
    });
    // And only the one approval was asked for.
    expect(h.app.deskmates.ctx.approvals.list()).toHaveLength(1);
  });

  it("records the cron time zone in runs.config_json", async () => {
    const bot = await seedCronBot(h);
    h.app.deskmates.cron.tick(MINUTE_10_05);
    expect((runsOf(h, bot)[0] as RunRecord).config).toMatchObject({ cronTimeZone: "UTC" });
    await h.app.deskmates.scheduler.drain();
  });
});

describe("cron runner across a restart (test strategy §5, clock going backwards)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deskmates-cron-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not fire the same minute again after the Gateway is rebuilt on the same file DB", async () => {
    const dbPath = join(dir, "gateway.sqlite");
    const first = await startHarness({ dbPath, cronTimeZone: "UTC" });
    first.provider.onRun(FINISH);
    const bot = await seedCronBot(first);
    first.app.deskmates.cron.tick(MINUTE_10_05);
    await waitFor(
      () => first.app.deskmates.ctx.runs.list({ botId: bot.id })[0]?.status === "succeeded",
      3000,
      "the first run to end",
    );
    await first.close();

    const second = await startHarness({ dbPath, cronTimeZone: "UTC" });
    second.provider.onRun(FINISH);
    second.app.deskmates.cron.tick(MINUTE_10_05);
    expect(second.app.deskmates.ctx.runs.list({ botId: bot.id })).toHaveLength(1);
    await second.close();
  });
});

describe("lanes (design v0.3 §3.4)", () => {
  it("runs a cron run and a chat run of the same bot at once, and queues two cron runs", async () => {
    const seeded = await h.seed();
    h.app.deskmates.ctx.bots.setCron(seeded.bot.id, [
      { schedule: "*/5 * * * *", prompt: "round one" },
      { schedule: "*/5 * * * *", prompt: "round two" },
    ]);
    const inflight = new Set<string>();
    const releases = new Map<string, () => void>();
    h.provider.onRun(
      async (req) =>
        new Promise((resolve) => {
          inflight.add(req.runId);
          releases.set(req.runId, () => {
            inflight.delete(req.runId);
            resolve(undefined);
          });
        }),
    );

    h.app.deskmates.cron.tick(MINUTE_10_05);
    await h.api("POST", `/api/threads/${seeded.thread.id}/messages`, { body: "hello" });

    // Two entries, so two cron runs; they share the background lane and run one at a time, while
    // the interactive run of the same bot is in flight beside the first of them.
    await waitFor(() => inflight.size === 2, 3000, "one background and one interactive run");
    const runs = () => h.app.deskmates.ctx.runs.list({ botId: seeded.bot.id });
    const byLane = (lane: string, status: string) =>
      runs().filter((r) => r.lane === lane && r.status === status);
    expect(byLane("background", "running")).toHaveLength(1);
    expect(byLane("background", "queued")).toHaveLength(1);
    expect(byLane("interactive", "running")).toHaveLength(1);

    for (const release of [...releases.values()]) release();
    await waitFor(
      () =>
        byLane("background", "running").length === 1 && byLane("background", "queued").length === 0,
      3000,
      "the second cron run to start after the first ended",
    );
    for (const release of [...releases.values()]) release();
    await h.app.deskmates.scheduler.drain();
  });
});

describe("cron configuration", () => {
  it("rejects a bad cron expression on create and validates a PATCH that replaces the entries", async () => {
    const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
      name: "ws-x",
      defaultBot: false,
    });
    const bad = await h.api<{ code: string }>("POST", "/api/bots", {
      name: "badcron",
      workspaceId: ws.json.workspace.id,
      cron: [{ schedule: "*/0 * * *", prompt: "nope" }],
    });
    expect(bad.status).toBe(400);
    expect(bad.json.code).toBe("validation");
    expect(h.app.deskmates.ctx.bots.list().filter((b) => b.name === "badcron")).toHaveLength(0);

    const bot = await seedCronBot(h);
    const patched = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      cron: [{ schedule: "0 9 * * 1-5", prompt: "daily standup" }],
    });
    expect(patched.status).toBe(200);
    expect(patched.json.bot.cron).toEqual([{ schedule: "0 9 * * 1-5", prompt: "daily standup" }]);

    const rejected = await h.api("PATCH", `/api/bots/${bot.id}`, {
      cron: [{ schedule: "0 9 * * 1-5", prompt: "" }],
    });
    expect(rejected.status).toBe(400);
    expect(h.app.deskmates.ctx.bots.mustGet(bot.id).cron).toEqual([
      { schedule: "0 9 * * 1-5", prompt: "daily standup" },
    ]);
  });
});

describe("missed cron minutes are skipped, not back-filled (ADR-0029 decision 11)", () => {
  /** The runner's own log, where a start names the minutes nobody fired. */
  function captureLog(): Array<[string, Record<string, unknown> | undefined]> {
    const lines: Array<[string, Record<string, unknown> | undefined]> = [];
    const cron = h.app.deskmates.cron as unknown as {
      log: (msg: string, data?: Record<string, unknown>) => void;
    };
    cron.log = vi.fn((msg, data) => lines.push([msg, data]));
    return lines;
  }

  it("fires none of the minutes a stopped Gateway missed and logs them once per entry", async () => {
    const bot = await seedCronBot(h);
    const lines = captureLog();
    // Last alive at 10:01; started again at 10:16:10. 10:05, 10:10 and 10:15 were missed.
    const found = h.app.deskmates.cron.catchUp(
      "2026-09-22T10:01:20.000Z",
      new Date("2026-09-22T10:16:10.000Z"),
    );
    expect(found).toEqual([
      {
        botId: bot.id,
        entry: 0,
        schedule: "*/5 * * * *",
        minutes: [
          "2026-09-22T10:05:00.000Z",
          "2026-09-22T10:10:00.000Z",
          "2026-09-22T10:15:00.000Z",
        ],
        count: 3,
        truncated: false,
      },
    ]);
    expect(
      lines.filter(([msg]) => msg.includes("skipped while the Gateway was stopped")),
    ).toHaveLength(1);
    expect(runsOf(h, bot)).toEqual([]);
    // A first start, with no previous Gateway, missed nothing.
    expect(h.app.deskmates.cron.catchUp(undefined)).toEqual([]);
  });

  it("an entry with misfire run_once fires exactly one catch-up round, for the latest minute", async () => {
    const bot = await seedCronBot(h, [
      { schedule: "*/5 * * * *", prompt: "catch up", misfire: "run_once" } as never,
    ]);
    const now = new Date("2026-09-22T10:16:10.000Z");
    const [found] = h.app.deskmates.cron.catchUp("2026-09-22T10:01:20.000Z", now);
    expect(found?.caughtUpRunId).toBeDefined();
    h.app.deskmates.cron.catchUp("2026-09-22T10:01:20.000Z", now);
    const runs = runsOf(h, bot);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.triggerRef).toBe("cron:0:2026-09-22T10:15:00.000Z");
    await h.app.deskmates.scheduler.drain();
  });

  it("does not name a minute the previous Gateway fired before its last-seen mark caught up", async () => {
    const bot = await seedCronBot(h, [
      { schedule: "*/5 * * * *", prompt: "catch up", misfire: "run_once" } as never,
    ]);
    // The old Gateway was last seen at 10:04:30, fired 10:05 and stopped before marking alive.
    h.app.deskmates.cron.tick(MINUTE_10_05);
    await waitFor(() => runsOf(h, bot)[0]?.status === "succeeded", 3000, "the 10:05 run");
    const [found] = h.app.deskmates.cron.catchUp(
      "2026-09-22T10:04:30.000Z",
      new Date("2026-09-22T10:16:10.000Z"),
    );
    expect(found?.minutes).toEqual(["2026-09-22T10:10:00.000Z", "2026-09-22T10:15:00.000Z"]);
    expect(found?.count).toBe(2);
    expect(found?.caughtUpRunId).toBeDefined();
    // A repeated start never fires a round older than one that already ran.
    h.app.deskmates.cron.catchUp("2026-09-22T10:04:30.000Z", new Date("2026-09-22T10:16:10.000Z"));
    expect(runsOf(h, bot).map((r) => r.triggerRef)).toEqual(
      expect.arrayContaining([
        "cron:0:2026-09-22T10:05:00.000Z",
        "cron:0:2026-09-22T10:15:00.000Z",
      ]),
    );
    expect(runsOf(h, bot)).toHaveLength(2);
    await h.app.deskmates.scheduler.drain();
  });

  it("accepts misfire on a cron entry through the API and stores only the opt-in", async () => {
    const bot = await seedCronBot(h);
    const patched = await h.api<{ bot: BotDefinition }>("PATCH", `/api/bots/${bot.id}`, {
      cron: [
        { schedule: "0 9 * * *", prompt: "daily", misfire: "run_once" },
        { schedule: "0 10 * * *", prompt: "skip", misfire: "skip" },
      ],
    });
    expect(patched.status).toBe(200);
    expect(patched.json.bot.cron).toEqual([
      { schedule: "0 9 * * *", prompt: "daily", misfire: "run_once" },
      { schedule: "0 10 * * *", prompt: "skip" },
    ]);
    const bad = await h.api("PATCH", `/api/bots/${bot.id}`, {
      cron: [{ schedule: "0 9 * * *", prompt: "daily", misfire: "always" }],
    });
    expect(bad.status).toBe(400);
  });

  it("cancels a round queued during a drain that could start only past the grace", async () => {
    const bot = await seedCronBot(h);
    const { scheduler, ctx } = h.app.deskmates;
    scheduler.startDrain();
    h.app.deskmates.cron.tick(MINUTE_10_05);
    const [queued] = runsOf(h, bot);
    expect(queued?.config.queuedInDrain).toBe(true);
    // Six minutes later the drain ends (CRON_MISFIRE_GRACE is 5 by default).
    scheduler.clock = () => new Date("2026-09-22T10:11:00.000Z");
    scheduler.endDrain();
    await waitFor(
      () => ctx.runs.mustGet(queued?.id as never).status === "cancelled",
      3000,
      "the misfire",
    );
    expect(ctx.runs.mustGet(queued?.id as never).error).toBe(RUN_ERROR_CRON_MISFIRE);
    expect(h.provider.execCalls).toHaveLength(0);
  });

  it("starts a round queued during a drain that ends inside the grace", async () => {
    const bot = await seedCronBot(h);
    const { scheduler, ctx } = h.app.deskmates;
    scheduler.startDrain();
    h.app.deskmates.cron.tick(MINUTE_10_05);
    const [queued] = runsOf(h, bot);
    scheduler.clock = () => new Date("2026-09-22T10:08:00.000Z");
    scheduler.endDrain();
    await waitFor(
      () => ctx.runs.mustGet(queued?.id as never).status === "succeeded",
      3000,
      "the round",
    );
    // A round queued outside any drain is never a misfire, however long it waited.
    scheduler.clock = () => new Date("2026-09-22T12:00:00.000Z");
    h.app.deskmates.cron.tick(MINUTE_10_10);
    await waitFor(
      () => runsOf(h, bot).length === 2 && runsOf(h, bot).every((r) => r.status === "succeeded"),
      3000,
      "the next round to run, not to be cancelled",
    );
  });
});

describe("a parked threadless round does not block later ticks silently (ADR-0029 decision 12)", () => {
  async function seedWithChat(): Promise<{ bot: BotDefinition; chatId: string }> {
    const bot = await seedCronBot(h);
    const chat = h.app.deskmates.ctx.threads.create({
      workspaceId: bot.workspaceId,
      botIds: [bot.id],
    });
    return { bot, chatId: chat.id };
  }

  const skipNotices = (chatId: string) =>
    h.app.deskmates.ctx.messages
      .list(chatId as never, 0)
      .filter((m) => m.authorKind === "system" && m.body.includes("skipped its round"));

  it("a round parked on a continuation ask: one notice, then at most one an hour", async () => {
    const { bot, chatId } = await seedWithChat();
    h.provider.onRun(async (req, gw) => {
      await gw.post("ended", {
        type: "run_ended",
        runId: req.runId,
        outcome: "turns_exhausted",
        sdkSessionId: "sess-cron-turns",
        usage: [],
      });
      return undefined;
    });
    h.app.deskmates.cron.tick(MINUTE_10_05);
    await waitFor(
      () => runsOf(h, bot)[0]?.status === "waiting_continuation",
      3000,
      "the round to park on its continuation ask",
    );
    const parked = runsOf(h, bot)[0] as RunRecord;

    h.app.deskmates.cron.tick(MINUTE_10_10);
    h.app.deskmates.cron.tick(new Date("2026-09-22T10:15:00.000Z"));
    h.app.deskmates.cron.tick(new Date("2026-09-22T11:05:00.000Z"));
    expect(skipNotices(chatId)).toHaveLength(1);
    expect(skipNotices(chatId)[0]?.body).toContain(parked.id);
    expect(skipNotices(chatId)[0]?.body).toContain("a continuation decision");
    // An hour after the first notice, the next skip says so again.
    h.app.deskmates.cron.tick(new Date("2026-09-22T11:10:00.000Z"));
    expect(skipNotices(chatId)).toHaveLength(2);
    // Still skipped, so nobody is asked twice.
    expect(runsOf(h, bot)).toHaveLength(1);
    expect(
      h.app.deskmates.ctx.events
        .list(parked.id)
        .filter((e) => e.kind === "log" && e.payload.op === "parked_skip_notice"),
    ).toHaveLength(2);
  });

  it("a round the platform parked posts no notice: it resumes by itself", async () => {
    const { bot, chatId } = await seedWithChat();
    const { ctx, scheduler } = h.app.deskmates;
    scheduler.stop();
    h.app.deskmates.cron.tick(MINUTE_10_05);
    const [round] = runsOf(h, bot);
    ctx.runs.transition(round?.id as never, "running");
    ctx.runs.transition(round?.id as never, "waiting_platform", {
      resumePayload: { sdkSessionId: "sess-p", platform: "drain" },
    });
    h.app.deskmates.cron.tick(MINUTE_10_10);
    expect(runsOf(h, bot)).toHaveLength(1);
    expect(skipNotices(chatId)).toHaveLength(0);
  });
});
