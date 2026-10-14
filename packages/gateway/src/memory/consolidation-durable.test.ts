import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// ADR-0011 A1: exercise persisted counters, not just the time/threshold predicate.
import type { RunId } from "@deskmates/contracts";
import { afterEach, expect, it } from "vitest";
import { buildGateway } from "../index.js";
import { FakeProvider } from "../test-support/fake-provider.js";
import { testConfig } from "../test-support/harness.js";
import { type MemoryFixture, memoryFixture } from "../test-support/memory-fixture.js";
import { CONSOLIDATION_POLICY, ConsolidationService } from "./consolidation.js";

let f: MemoryFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});
const stamp = "2026-10-02T00:00:00.000Z";
const nextDay = new Date("2026-10-03T00:00:00.000Z");

function candidate(fixture: Pick<MemoryFixture, "ctx">, runId: RunId, label: string) {
  const run = fixture.ctx.runs.mustGet(runId);
  return fixture.ctx.memory.entries.insert({
    workspaceId: fixture.ctx.bots.mustGet(run.botId).workspaceId,
    botId: run.botId,
    scope: "bot",
    kind: "candidate",
    body: `Observed fixture fact ${label}.`,
    authority: "fact",
    trust: "trusted",
    sourceKind: "bot_self",
    sourceRunId: runId,
    observedAt: stamp,
    by: `bot:${run.botId}`,
  });
}

function restored(fixture: MemoryFixture) {
  const { ctx } = fixture;
  return new ConsolidationService({
    db: ctx.db,
    runs: ctx.runs,
    stores: ctx.memory.stores,
    workspaceOf: (id) => ctx.bots.mustGet(id).workspaceId,
    runConfig: () => ctx.runConfig(),
    cheapModelOf: (id) => ctx.bots.mustGet(id).cheapModel ?? ctx.config.cheapModel,
  });
}

it("persists the threshold and prevents a second queued run after service reconstruction", async () => {
  f = await memoryFixture();
  const fixture = f;
  const source = f.run("a", false);
  const ids = Array.from({ length: 9 }, (_, i) => candidate(fixture, source, String(i)).id);
  expect(f.ctx.memory.consolidation.requestEligible(nextDay)).toEqual([]);
  ids.push(candidate(f, source, "tenth").id);
  const queued = restored(f).requestEligible(nextDay);
  expect(queued).toHaveLength(1);
  expect(queued[0]?.lane).toBe("background");
  expect(queued[0]?.config.consolidationPolicy).toEqual(CONSOLIDATION_POLICY);
  expect((queued[0]?.config.consolidationSources as string[]).sort()).toEqual(ids.sort());
  expect(restored(f).requestEligible(nextDay)).toEqual([]);
});

it("honors workspace activity and failed-attempt cooldown across service reconstruction", async () => {
  f = await memoryFixture();
  const source = f.run("a", false);
  for (let i = 0; i < 10; i++) candidate(f, source, String(i));
  const interactive = f.run();
  f.ctx.db
    .prepare("UPDATE runs SET finished_at = ? WHERE id = ?")
    .run("2026-10-02T23:51:00.000Z", interactive);
  expect(restored(f).requestEligible(nextDay)).toEqual([]);
  f.ctx.db
    .prepare("UPDATE runs SET finished_at = ?, status = 'running' WHERE id = ?")
    .run("2026-10-02T23:50:00.000Z", interactive);
  expect(restored(f).requestEligible(nextDay)).toEqual([]);
  f.ctx.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(interactive);
  const queued = restored(f).requestEligible(nextDay);
  expect(queued).toHaveLength(1);
  f.ctx.db
    .prepare("UPDATE runs SET status = 'failed', created_at = ? WHERE id = ?")
    .run(nextDay.toISOString(), queued[0]?.id);
  expect(restored(f).requestEligible(new Date("2026-10-03T23:59:59.999Z"))).toEqual([]);
  expect(restored(f).requestEligible(new Date("2026-10-04T00:00:00.000Z"))).toHaveLength(1);
});

it("does not count failed runs, consolidation output or another bot's candidates", async () => {
  f = await memoryFixture();
  const failed = f.run("a", false);
  f.ctx.db.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(failed);
  for (let i = 0; i < 10; i++) candidate(f, failed, `failed-${i}`);
  const other = f.run("b", false);
  for (let i = 0; i < 9; i++) candidate(f, other, `other-${i}`);
  candidate(f, f.run("a", false), "ordinary-source");
  const manual = f.ctx.memory.consolidation.request(f.a.bot.id);
  f.ctx.db
    .prepare("UPDATE runs SET status = 'succeeded', created_at = ? WHERE id = ?")
    .run(stamp, manual.id);
  for (let i = 0; i < 10; i++) candidate(f, manual.id, `self-${i}`);
  expect(restored(f).requestEligible(nextDay)).toEqual([]);
});

it("counts sources created after a successful snapshot even at the same millisecond", async () => {
  f = await memoryFixture();
  const source = f.run("a", false);
  for (let i = 0; i < 10; i++) candidate(f, source, `old-${i}`);
  const prior = f.ctx.memory.consolidation.request(f.a.bot.id);
  f.ctx.db
    .prepare("UPDATE runs SET status = 'silent', created_at = ? WHERE id = ?")
    .run(stamp, prior.id);
  // Empty consolidation output must not repeatedly re-trigger its old source set.
  expect(restored(f).requestEligible(nextDay)).toEqual([]);
  for (let i = 0; i < 9; i++) candidate(f, source, `new-${i}`);
  expect(restored(f).requestEligible(nextDay)).toEqual([]);
  candidate(f, source, "new-tenth");
  expect(restored(f).requestEligible(nextDay)).toHaveLength(1);
});

it("also triggers on three closed episodes without bot candidates", async () => {
  f = await memoryFixture();
  for (let i = 0; i < 3; i++) {
    const thread = f.ctx.threads.create({ workspaceId: f.a.workspace.id, botIds: [f.a.bot.id] });
    const run = f.ctx.runs.create({
      botId: f.a.bot.id,
      threadId: thread.id,
      lane: "interactive",
      triggerKind: "thread_message",
      triggerRef: `episode-${i}`,
      config: f.ctx.runConfig(),
    });
    f.ctx.db
      .prepare("UPDATE runs SET status = 'silent', created_at = ?, finished_at = ? WHERE id = ?")
      .run(stamp, stamp, run.id);
    f.ctx.memory.entries.insert({
      workspaceId: f.a.workspace.id,
      threadId: thread.id,
      scope: "workspace",
      kind: "episode",
      body: `Closed task ${i}.`,
      authority: "fact",
      trust: "trusted",
      sourceKind: "bot_self",
      sourceRunId: run.id,
      observedAt: stamp,
      by: `bot:${f.a.bot.id}`,
    });
    const queued = restored(f).requestEligible(nextDay);
    expect(queued).toHaveLength(i === 2 ? 1 : 0);
    if (i === 2) expect(queued[0]?.config.consolidationSources).toHaveLength(3);
  }
});

it("retains the counter and pending-run guard when the Gateway database is closed and reopened", async () => {
  const directory = mkdtempSync(join(tmpdir(), "deskmates-consolidation-restart-"));
  const config = testConfig({ dbPath: join(directory, "gateway.sqlite") });
  let app: ReturnType<typeof buildGateway> | undefined;
  const open = async () => {
    app = buildGateway(config, new FakeProvider(), { surface: "combined-test", startCron: false });
    // The test inspects restart recovery before deliberately starting another sidecar.
    app.deskmates.scheduler.stop();
    await app.ready();
    return app.deskmates.ctx;
  };
  const close = async () => {
    await app?.close();
    app = undefined;
  };
  try {
    let ctx = await open();
    const workspace = ctx.workspaces.create({
      name: "restart-memory",
      sandboxProvider: "docker",
      egressAllowlist: [],
    });
    const bot = ctx.bots.create({ name: "restartbot", role: "test", workspaceId: workspace.id });
    const source = ctx.runs.create({
      botId: bot.id,
      lane: "background",
      triggerKind: "cron",
      triggerRef: "restart-source",
      config: ctx.runConfig(),
    });
    ctx.db.prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?").run(source.id);
    for (let i = 0; i < 9; i++) candidate({ ctx }, source.id, `restart-${i}`);
    expect(ctx.memory.consolidation.requestEligible(nextDay)).toEqual([]);
    await close();
    ctx = await open();
    candidate({ ctx }, source.id, "restart-tenth");
    const queued = ctx.memory.consolidation.requestEligible(nextDay);
    expect(queued).toHaveLength(1);
    await close();
    ctx = await open();
    expect(ctx.runs.mustGet(queued[0]?.id as RunId).status).toBe("queued");
    expect(ctx.memory.consolidation.requestEligible(nextDay)).toEqual([]);
    expect(
      ctx.runs
        .list({ botId: bot.id })
        .filter((run) => run.config.runType === "memory_consolidation"),
    ).toHaveLength(1);
  } finally {
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
