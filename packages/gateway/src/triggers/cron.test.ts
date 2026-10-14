// T1: the cron runner against a live Gateway with the fake provider (test strategy §4.2
// "cron overlap", §5 "clock going backwards"). Every case drives `tick` with an injected clock;
// the minute timer itself is not started in tests.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotDefinition, StartRunRequest, Workspace } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    const ws = await h.api<{ workspace: Workspace }>("POST", "/api/workspaces", { name: "ws-x" });
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
