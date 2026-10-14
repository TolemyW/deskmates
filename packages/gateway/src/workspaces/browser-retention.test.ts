import type { BotId, RunId, RunStatus } from "@deskmates/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { retentionCandidates } from "./browser-retention.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
let app: ReturnType<typeof buildGateway>;

beforeEach(() => {
  app = buildGateway(
    testConfig({ browserRetainedTabs: 20, browserTabRetentionHours: 24 }),
    new FakeProvider(),
    { surface: "combined-test", startCron: false },
  );
  app.deskmates.scheduler.stop();
});

afterEach(async () => {
  await app.close();
});

function seedWorkspace(name = "retention") {
  const { ctx } = app.deskmates;
  const workspace = ctx.workspaces.create({ name, sandboxProvider: "docker" });
  const bot = ctx.bots.create({ workspaceId: workspace.id, name: `${name}-bot`, role: "tester" });
  return { workspace, bot };
}

function seedRun(
  botId: BotId,
  id: string,
  status: RunStatus,
  targetId: string,
  acquiredAt: string,
  finishedAt?: string,
): RunId {
  const { ctx } = app.deskmates;
  const run = ctx.runs.create({
    botId,
    lane: "background",
    triggerKind: "webhook",
    triggerRef: id,
    triggerPayload: {},
    config: ctx.runConfig(),
  });
  ctx.events.append({
    runId: run.id,
    kind: "log",
    payload: { source: "browser_lock", op: "tab_acquired", tabId: targetId },
    ts: acquiredAt,
  });
  ctx.db
    .prepare("UPDATE runs SET status = ?, finished_at = ? WHERE id = ?")
    .run(status, finishedAt ?? null, run.id);
  return run.id;
}

describe("browser target retention", () => {
  it("retains the newest twenty recent targets and closes overflow oldest first", () => {
    const { bot } = seedWorkspace();
    const current = seedRun(bot.id, "run-current", "running", "current", NOW.toISOString());
    for (let index = 0; index < 25; index += 1) {
      const completedAt = new Date(NOW.getTime() - (index + 1) * 60_000).toISOString();
      seedRun(bot.id, `run-${index}`, "succeeded", `target-${index}`, completedAt, completedAt);
    }
    expect(retentionCandidates(app.deskmates.ctx, current, NOW)).toEqual(
      [24, 23, 22, 21, 20].map((index) => `target-${index}`),
    );
  });

  it("closes expired targets even when fewer than the retained count exist", () => {
    const { bot } = seedWorkspace();
    const current = seedRun(bot.id, "run-current", "running", "current", NOW.toISOString());
    for (let index = 0; index < 19; index += 1) {
      const recent = new Date(NOW.getTime() - (index + 1) * 60_000).toISOString();
      seedRun(bot.id, `recent-${index}`, "succeeded", `recent-${index}`, recent, recent);
    }
    for (let index = 0; index < 3; index += 1) {
      const expired = new Date(NOW.getTime() - (25 + index) * 60 * 60_000).toISOString();
      seedRun(bot.id, `expired-${index}`, "succeeded", `expired-${index}`, expired, expired);
    }

    expect(retentionCandidates(app.deskmates.ctx, current, NOW)).toEqual([
      "expired-2",
      "expired-1",
      "expired-0",
    ]);
  });

  it("rejects cross-workspace, live, leased, reused, current-run, and closed targets", () => {
    const { ctx } = app.deskmates;
    ctx.config.browserRetainedTabs = 0;
    const { workspace, bot } = seedWorkspace();
    const other = seedWorkspace("other");
    const current = seedRun(
      bot.id,
      "run-current",
      "running",
      "current",
      "2026-09-23T11:59:00.000Z",
    );
    seedRun(
      bot.id,
      "run-eligible",
      "succeeded",
      "eligible",
      "2026-09-23T09:00:00.000Z",
      "2026-09-23T10:00:00.000Z",
    );
    seedRun(
      bot.id,
      "run-reused-old",
      "succeeded",
      "reused",
      "2026-09-23T08:00:00.000Z",
      "2026-09-23T08:30:00.000Z",
    );
    seedRun(bot.id, "run-reused-live", "waiting_approval", "reused", "2026-09-23T11:00:00.000Z");
    seedRun(
      bot.id,
      "run-leased",
      "failed",
      "leased",
      "2026-09-23T09:00:00.000Z",
      "2026-09-23T09:30:00.000Z",
    );
    seedRun(
      bot.id,
      "run-closed",
      "silent",
      "closed",
      "2026-09-23T09:00:00.000Z",
      "2026-09-23T09:45:00.000Z",
    );
    seedRun(
      other.bot.id,
      "run-other",
      "succeeded",
      "other-target",
      "2026-09-23T11:00:00.000Z",
      "2026-09-23T11:30:00.000Z",
    );
    ctx.locks.handle(workspace.id, {
      type: "browser_lock",
      op: "acquire",
      runId: current,
      tabId: "leased",
    });
    ctx.events.append({
      runId: current,
      kind: "log",
      payload: { source: "browser_retention", phase: "closed", targetIds: ["closed"] },
    });

    expect(retentionCandidates(ctx, current, NOW)).toEqual(["eligible"]);
  });
});
