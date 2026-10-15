// T1 (ADR-0011 amendment 4, A28, A30, A34; owner ruling 2026-10-14): the model rechecks flagged
// notes automatically on a cheap-model job. Only eligible flags are sent, the daily limit bounds
// them, `still_true` renews a note as a model confirmation, `possibly_stale` waits for a person,
// `unclear` waits a day, and nothing is retried. Daily organisation is queued by the same pass.

import type {
  MemoryMaintenanceSettings,
  MemoryRecheckJob,
  MemoryRevalidation,
  StartRunRequest,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../ledger/runs.js";
import type { FakeSidecarClient } from "../test-support/fake-provider.js";
import { type Harness, startHarness, waitFor } from "../test-support/harness.js";
import { MAINTENANCE_PASS_INTERVAL_MS, queueMemoryMaintenance } from "./maintenance-due.js";
import { DAILY_REQUESTER } from "./organize.js";

let h: Harness | undefined;
let reply: (request: StartRunRequest) => string = () => "";
const jobs: StartRunRequest[] = [];

async function playSidecar(request: StartRunRequest, gw: FakeSidecarClient): Promise<void> {
  if (request.modelJob?.kind === "memory_recheck") jobs.push(request);
  const text = request.modelJob?.kind === "memory_recheck" ? reply(request) : "";
  await gw.post("ended", {
    type: "run_ended",
    runId: request.runId,
    outcome: text ? "completed" : "failed",
    ...(text
      ? {
          summary: {
            done: "Memory recheck verdicts",
            reply: text,
            filesChanged: [],
            sitesVisited: [],
            pendingApprovals: [],
            memorySuggestions: [],
          },
        }
      : { error: "model unavailable" }),
    usage: [
      {
        model: request.model,
        inputTokens: 90,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreateTokens: 0,
      },
    ],
  });
}

afterEach(async () => {
  await h?.close();
  h = undefined;
  reply = () => "";
  jobs.length = 0;
});

const OLD = new Date(Date.now() - 3 * 86_400_000).toISOString();

async function setup() {
  h = await startHarness();
  h.provider.onRun(playSidecar);
  const harness = h;
  const make = async (name: string) =>
    (
      await harness.api<{ workspace: Workspace }>("POST", "/api/workspaces", {
        name,
        egressAllowlist: ["docs.example.test"],
      })
    ).json.workspace;
  const workspace = await make("ws");
  const other = await make("other");
  const bot = (
    await harness.api<{ bot: { id: string } }>("POST", "/api/bots", {
      name: "keeper",
      role: "ops",
      workspaceId: workspace.id,
      welcome: false,
    })
  ).json.bot;
  const ctx = harness.app.deskmates.ctx;
  const note = (
    body: string,
    over: { trust?: "trusted" | "untrusted"; workspaceId?: WorkspaceId } = {},
  ) =>
    ctx.memory.entries.insert({
      workspaceId: over.workspaceId ?? workspace.id,
      scope: "workspace",
      kind: "note",
      body,
      authority: "fact",
      trust: over.trust ?? "trusted",
      sourceKind: over.trust === "untrusted" ? "page" : "bot_self",
      observedAt: OLD,
      effectiveAt: OLD,
      by: "test",
    });
  const flags = (view: "all" | "needs_human" = "all") =>
    ctx.memory.freshness.page(workspace.id, { limit: 100, needsHuman: view === "needs_human" });
  const flagOf = (entryId: string) =>
    ctx.db.prepare("SELECT * FROM memory_revalidations WHERE entry_id = ?").get(entryId) as {
      id: string;
      status: string;
      decided_by: string | null;
      model_verdict: string | null;
    };
  const launch = () => harness.app.deskmates.scheduler.kick();
  return { harness, ctx, workspace, other, bot, note, flags, flagOf, launch };
}

async function settled(harness: Harness, workspaceId: WorkspaceId): Promise<MemoryRecheckJob> {
  let job: MemoryRecheckJob | undefined;
  await waitFor(
    async () => {
      job = (
        await harness.api<{ recheck?: MemoryRecheckJob }>(
          "GET",
          `/api/workspaces/${workspaceId}/memory/maintenance`,
        )
      ).json.recheck;
      return job !== undefined && job.status !== "pending";
    },
    3000,
    "recheck settled",
  );
  return job as MemoryRecheckJob;
}

const verdicts = (items: { id: string; verdict: string; reason?: string }[]) =>
  JSON.stringify({ verdicts: items.map((i) => ({ reason: "seen in the thread", ...i })) });

describe("A28 which flags are sent", () => {
  it("queues one cheap-model job with only eligible flags and none while it is pending", async () => {
    const { ctx, workspace, note, flagOf } = await setup();
    const a = note("The ledger host is ledger.example.test");
    const b = note("The billing export runs on Mondays");
    const replaced = note("The quota page lists 50 seats", { trust: "untrusted" });
    ctx.memory.freshness.sweep(workspace.id);
    // The poisoning surface of A11 stays a human's.
    ctx.db
      .prepare("UPDATE memory_revalidations SET reason = 'replaced_trusted' WHERE entry_id = ?")
      .run(replaced.id);
    const queued = ctx.modelJobs.recheck.request(workspace.id);
    expect(queued?.job).toMatchObject({ status: "pending", noteCount: 2 });
    const run = queued?.run as RunRecord;
    expect(run.lane).toBe("background");
    expect(run.config).toMatchObject({
      runType: "memory_recheck",
      model: ctx.config.cheapModel,
      cheapModel: ctx.config.cheapModel,
      maxTurns: 1,
      memoryRecheckBounds: { maxNotes: 20, dailyLimit: 200 },
    });
    const input = (run.config.memoryRecheckInput as [string, string, number][]).map((t) => t[1]);
    expect(input.sort()).toEqual([a.id, b.id].sort());
    expect(input).not.toContain(replaced.id);
    expect(flagOf(replaced.id).status).toBe("open");
    // One pending job per workspace.
    expect(ctx.modelJobs.recheck.request(workspace.id)).toBeUndefined();
  });

  it("reads shared threads and tasks for the activity, never a private chat", async () => {
    const { ctx, workspace, bot, note } = await setup();
    note("The ledger host is ledger.example.test");
    const make = (title: string) =>
      ctx.threads.create({ workspaceId: workspace.id, botIds: [bot.id as never], title });
    const shared = make("Ops room");
    const secret = make("Alice private");
    ctx.db
      .prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('u_alice', 'Alice', ?, ?)",
      )
      .run(new Date().toISOString(), new Date().toISOString());
    ctx.db.prepare("UPDATE threads SET private_to_user_id = 'u_alice' WHERE id = ?").run(secret.id);
    ctx.messages.append({
      threadId: shared.id,
      authorKind: "human",
      authorId: "u_bob",
      body: "We moved the ledger to ledger2.example.test today",
    });
    ctx.messages.append({
      threadId: secret.id,
      authorKind: "human",
      authorId: "u_alice",
      body: "My salary is 12345",
    });
    const activity = ctx.modelJobs.recheck.activity(workspace.id);
    expect(activity).toContain("ledger2.example.test");
    expect(activity).not.toContain("12345");
    expect(activity).not.toContain("Alice private");
  });
});

describe("A28 verdicts", () => {
  it("renews still-true notes as a model confirmation and leaves the others open", async () => {
    const { harness, ctx, workspace, note, flags, flagOf, launch } = await setup();
    const kept = note("The ledger host is ledger.example.test", { trust: "untrusted" });
    const stale = note("The billing export runs on Mondays");
    const unclear = note("The audit report is due quarterly");
    ctx.memory.freshness.sweep(workspace.id);
    reply = () =>
      verdicts([
        { id: kept.id, verdict: "still_true" },
        { id: stale.id, verdict: "possibly_stale", reason: "Bob said it moved to Tuesdays" },
        { id: unclear.id, verdict: "unclear" },
        { id: "mem_unknown", verdict: "still_true" },
        { id: kept.id, verdict: "possibly_stale" },
      ]);
    const queued = ctx.modelJobs.recheck.request(workspace.id);
    launch();
    const job = await settled(harness, workspace.id);
    expect(job).toMatchObject({
      status: "ready",
      stillTrue: 1,
      possiblyStale: 1,
      unclear: 1,
      dropped: 0,
    });
    expect(jobs[0]?.modelJob).toMatchObject({ kind: "memory_recheck" });

    const renewed = ctx.memory.entries.mustGet(kept.id);
    expect(renewed.trust).toBe("untrusted");
    expect(renewed.body).toBe(kept.body);
    expect(renewed.lastConfirmedAt).toBeDefined();
    const version = ctx.memory.entries.version(kept.id, renewed.version);
    expect(version).toMatchObject({ op: "confirm", by: `model:${queued?.run.id}` });
    expect(flagOf(kept.id)).toMatchObject({
      status: "still_true",
      decided_by: `model:${queued?.run.id}`,
    });
    // No person decided: no audit row.
    expect(
      (
        ctx.db
          .prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'memory.revalidate'")
          .get() as { n: number }
      ).n,
    ).toBe(0);
    expect(ctx.memory.entries.mustGet(stale.id).version).toBe(stale.version);
    expect(flagOf(stale.id)).toMatchObject({ status: "open", model_verdict: "possibly_stale" });
    expect(flagOf(unclear.id)).toMatchObject({ status: "open", model_verdict: "unclear" });

    const human = flags("needs_human");
    expect(human.items.map((r) => r.entryId)).toEqual([stale.id]);
    expect(human.needsHuman).toBe(1);
    expect(human.items[0]?.model).toMatchObject({
      verdict: "possibly_stale",
      reason: "Bob said it moved to Tuesdays",
    });
    expect(flags().total).toBe(2);

    // possibly_stale waits for a person; unclear waits a day.
    const later = new Date(Date.now() + 2 * 3_600_000);
    expect(ctx.modelJobs.recheck.eligible(workspace.id, 20, later)).toEqual([]);
    const tomorrow = new Date(Date.now() + 25 * 3_600_000);
    expect(
      ctx.modelJobs.recheck.eligible(workspace.id, 20, tomorrow).map((e) => e.entryId),
    ).toEqual([unclear.id]);
  });

  it("keeps a model topic label through a confirmation and drops it on a body edit (A31)", async () => {
    const { ctx, workspace, note } = await setup();
    const a = note("The ledger host is ledger.example.test");
    ctx.db
      .prepare(
        "UPDATE memory_entries SET topic = 'ledger', topic_label = 'Ledger', topic_set = 1, topic_source = 'model' WHERE id = ?",
      )
      .run(a.id);
    const topic = () =>
      ctx.db.prepare("SELECT topic, topic_source FROM memory_entries WHERE id = ?").get(a.id);
    ctx.memory.entries.appendVersion(
      a.id,
      "confirm",
      { lastConfirmedAt: new Date().toISOString() },
      "model:run_x",
    );
    ctx.memory.entries.ensureTopics(workspace.id);
    expect(topic()).toEqual({ topic: "ledger", topic_source: "model" });
    ctx.memory.entries.appendVersion(
      a.id,
      "edit",
      { body: "The audit host is audit.example.test" },
      "human:o",
    );
    ctx.memory.entries.ensureTopics(workspace.id);
    expect(topic()).toMatchObject({ topic_source: "rule" });
  });

  it("drops a verdict on a note that changed after the job was queued", async () => {
    const { harness, ctx, workspace, note, flagOf, launch } = await setup();
    const a = note("The ledger host is ledger.example.test");
    const b = note("The billing export runs on Mondays");
    ctx.memory.freshness.sweep(workspace.id);
    reply = () =>
      verdicts([
        { id: a.id, verdict: "still_true" },
        { id: b.id, verdict: "still_true" },
      ]);
    ctx.modelJobs.recheck.request(workspace.id);
    // Edited after the job was queued: the job sends only notes still at the recorded version,
    // and a verdict the model gives about it anyway is dropped.
    ctx.memory.entries.appendVersion(
      b.id,
      "edit",
      { body: "The billing export runs on Tuesdays" },
      "human:o",
    );
    launch();
    const job = await settled(harness, workspace.id);
    expect(job).toMatchObject({ stillTrue: 1, dropped: 1 });
    expect(flagOf(a.id).status).toBe("still_true");
    expect(flagOf(b.id).status).toBe("open");
  });

  it("a failed job changes no flag and is not retried within its count", async () => {
    const { harness, ctx, workspace, note, flagOf, launch } = await setup();
    const a = note("The ledger host is ledger.example.test");
    ctx.memory.freshness.sweep(workspace.id);
    reply = () => "";
    ctx.modelJobs.recheck.request(workspace.id);
    launch();
    const job = await settled(harness, workspace.id);
    expect(job.status).toBe("failed");
    expect(flagOf(a.id)).toMatchObject({ status: "open", model_verdict: null });
    expect(ctx.modelJobs.recheck.usedToday(workspace.id, new Date())).toBe(1);
  });
});

describe("A34 settings and the daily limit", () => {
  it("defaults, validates, audits, and bounds the notes sent per day", async () => {
    const { harness, ctx, workspace, note } = await setup();
    const base = `/api/workspaces/${workspace.id}/memory/maintenance`;
    const read = await harness.api<{ settings: MemoryMaintenanceSettings }>("GET", base);
    expect(read.json.settings).toEqual({ recheckDailyLimit: 200, organizeDaily: true });
    expect((await harness.api("PUT", base, { recheckDailyLimit: 1001 })).status).toBe(400);
    expect((await harness.api("PUT", base, { recheckDailyLimit: 1.5 })).status).toBe(400);
    expect((await harness.api("PUT", base, { organizeDaily: "yes" })).status).toBe(400);
    const put = await harness.api<{ settings: MemoryMaintenanceSettings }>("PUT", base, {
      recheckDailyLimit: 2,
    });
    expect(put.json.settings).toEqual({ recheckDailyLimit: 2, organizeDaily: true });
    // An unchanged write is not audited again.
    await harness.api("PUT", base, { recheckDailyLimit: 2 });
    const audits = ctx.db
      .prepare(
        "SELECT COUNT(*) AS n FROM audit_events WHERE action = 'memory.maintenance_settings'",
      )
      .get() as { n: number };
    expect(audits.n).toBe(1);

    for (let i = 0; i < 3; i += 1) note(`Old fact ${i} about host h${i}.`);
    ctx.memory.freshness.sweep(workspace.id);
    const first = ctx.modelJobs.recheck.request(workspace.id);
    expect(first?.job.noteCount).toBe(2);
    // Settle it as failed by hand: the day's two notes are spent.
    ctx.db
      .prepare("UPDATE memory_recheck_jobs SET status = 'failed', finished_at = ? WHERE id = ?")
      .run(new Date().toISOString(), first?.job.id);
    expect(ctx.modelJobs.recheck.request(workspace.id)).toBeUndefined();
    const nextDay = new Date(Date.now() + 25 * 3_600_000);
    expect(ctx.modelJobs.recheck.request(workspace.id, nextDay)?.job.noteCount).toBe(2);

    await harness.api("PUT", base, { recheckDailyLimit: 0 });
    ctx.db
      .prepare(
        "UPDATE memory_recheck_jobs SET status = 'failed', finished_at = ? WHERE status = 'pending'",
      )
      .run(new Date().toISOString());
    expect(
      ctx.modelJobs.recheck.request(workspace.id, new Date(Date.now() + 60 * 3_600_000)),
    ).toBeUndefined();
  });
});

describe("the periodic pass", () => {
  it("queues one recheck and one daily organisation per workspace, throttled", async () => {
    const { harness, ctx, workspace, other, note } = await setup();
    note("The ledger host is ledger.example.test");
    // A workspace without a bot gets nothing.
    note("A fact of another workspace", { workspaceId: other.id });
    const t0 = new Date(Date.now() + 10 * MAINTENANCE_PASS_INTERVAL_MS);
    const runs = queueMemoryMaintenance(ctx, t0);
    expect(runs.map((r) => r.config.runType).sort()).toEqual(["memory_organize", "memory_recheck"]);
    expect(ctx.modelJobs.organize.latest(workspace.id)?.requestedBy).toBe(DAILY_REQUESTER);
    // Within the pass interval nothing is looked at again.
    expect(queueMemoryMaintenance(ctx, new Date(t0.getTime() + 1000))).toEqual([]);
    // Later, with both jobs still pending, nothing new.
    expect(
      queueMemoryMaintenance(ctx, new Date(t0.getTime() + 2 * MAINTENANCE_PASS_INTERVAL_MS)),
    ).toEqual([]);
    const page = await harness.api<{ revalidations: MemoryRevalidation[] }>(
      "GET",
      `/api/workspaces/${workspace.id}/memory/revalidations?view=needs_human`,
    );
    expect(page.status).toBe(200);
    expect(
      (await harness.api("GET", `/api/workspaces/${workspace.id}/memory/revalidations?view=x`))
        .status,
    ).toBe(400);
  });

  it("does not queue daily organisation when it is switched off", async () => {
    const { harness, ctx, workspace, note } = await setup();
    note("The ledger host is ledger.example.test");
    await harness.api("PUT", `/api/workspaces/${workspace.id}/memory/maintenance`, {
      organizeDaily: false,
      recheckDailyLimit: 0,
    });
    const t0 = new Date(Date.now() + 10 * MAINTENANCE_PASS_INTERVAL_MS);
    expect(queueMemoryMaintenance(ctx, t0)).toEqual([]);
    expect(ctx.modelJobs.organize.latest(workspace.id)).toBeUndefined();
  });
});
