// T1, ADR-0046 decision 9 and amendment 2 decisions 23 to 26: the failure retrospective, against a
// fake embedding server. A failed run's nearest succeeded runs of its workspace are stored with
// their similarity; every embedding request is in `retrieval_calls`; a private chat's run is never
// sent, stored or matched; a run marked wrong is never offered; a pending summary holds the walk,
// then is skipped; and nothing runs, or is called, without an embedding service.

import { join } from "node:path";
import type { RunId } from "@deskmates/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalSettings } from "../config/retrieval.js";
import { testConfig } from "../test-support/harness.js";
import { type Ctx, LATER, ledgerHarness, tempDir } from "../test-support/observability-ledger.js";
import { createObservabilityModule } from "./observability-module.js";
import { Retrospective, SUMMARY_WAIT_MS } from "./retrospective.js";
import { createSqliteSink } from "./sqlite-sink.js";

const EMBEDDING = { url: "http://embedding.test/api/embed", model: "embed-test" };
const RETRIEVAL: RetrievalSettings = {
  embedding: EMBEDDING,
  candidates: 50,
  rrfK: 60,
  rerankTopN: 20,
  minSimilarity: 0.45,
};

/** Axes of the fake embedding: a text's vector counts these words, plus a small constant. */
const AXES = ["login", "timeout", "report", "upload", "secret"];

function fakeEmbedding() {
  const inputs: string[][] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; input: string[] };
    inputs.push(body.input);
    const embeddings = body.input.map((text) => {
      const words = text.toLowerCase().split(/\W+/);
      return [...AXES.map((axis) => words.filter((w) => w === axis).length), 0.1];
    });
    return new Response(JSON.stringify({ embeddings, prompt_eval_count: body.input.length * 7 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchImpl, inputs };
}

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function setup() {
  const l = await ledgerHarness();
  cleanup.push(() => l.h.close());
  const t = tempDir("obs-retro");
  cleanup.push(t.remove);
  return { ...l, dir: t.dir };
}

let n = 0;
/** A finished ordinary run whose card shows `reply` (or `error` when failed). */
function finishedRun(
  ctx: Ctx,
  ids: { botId: string; threadId: string },
  status: "succeeded" | "failed",
  text: string,
  finishedAt: string,
): RunId {
  n++;
  const run = ctx.runs.create({
    botId: ids.botId as never,
    threadId: ids.threadId as never,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: `retro-${n}`,
    config: { model: "model-a" },
  });
  ctx.db
    .prepare(
      "UPDATE runs SET status = ?, started_at = ?, finished_at = ?, error = ?, summary_json = ? WHERE id = ?",
    )
    .run(
      status,
      finishedAt,
      finishedAt,
      status === "failed" ? text : null,
      status === "succeeded" ? JSON.stringify({ reply: text }) : null,
      run.id,
    );
  return run.id;
}

const at = (minutes: number) =>
  new Date(Date.parse("2026-10-18T00:00:00.000Z") + minutes * 60_000).toISOString();
const NOW = () => new Date("2026-10-18T06:00:00.000Z");

function retrospective(ctx: Ctx, path: string, fetchImpl: typeof fetch, now = NOW) {
  const sink = createSqliteSink({ path });
  const store = sink.vectors;
  if (!store) throw new Error("the sqlite sink has no vector store");
  const retro = new Retrospective({
    db: ctx.db,
    vectors: store,
    embedding: EMBEDDING,
    fetch: fetchImpl,
    now,
  });
  return { sink, retro };
}

function matchesOf(path: string, failed: string) {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .prepare(
        "SELECT rank, match_run_id, similarity FROM retrospective_matches WHERE failed_run_id = ? ORDER BY rank",
      )
      .all(failed) as Array<{ rank: number; match_run_id: string; similarity: number }>;
  } finally {
    db.close();
  }
}

describe("the failure retrospective (ADR-0046 amendment 2)", () => {
  it("stores a failed run's nearest succeeded runs with their similarity, and records every call", async () => {
    const l = await setup();
    const path = join(l.dir, "obs.sqlite");
    const login = finishedRun(l.ctx, l, "succeeded", "Signed in through the login page.", at(1));
    const report = finishedRun(l.ctx, l, "succeeded", "Wrote the report and the upload.", at(2));
    const failed = finishedRun(l.ctx, l, "failed", "login timeout on the login page", at(3));
    const embed = fakeEmbedding();
    const { sink, retro } = retrospective(l.ctx, path, embed.fetchImpl);
    await sink.ensureSchema();
    await retro.step();
    await sink.close();

    const matches = matchesOf(path, failed);
    expect(matches.map((m) => [m.rank, m.match_run_id])).toEqual([
      [1, login],
      [2, report],
    ]);
    expect(matches[0]?.similarity).toBeGreaterThan(matches[1]?.similarity ?? 1);
    expect(matches[0]?.similarity).toBeLessThanOrEqual(1);
    // Succeeded runs are embedded and offered, never matched themselves.
    expect(matchesOf(path, login)).toEqual([]);

    const calls = l.ctx.db
      .prepare(
        "SELECT tenant_id, run_id, corpus, purpose, service, model, inputs, input_tokens, outcome FROM retrieval_calls",
      )
      .all();
    const tenant = (
      l.ctx.db.prepare("SELECT tenant_id FROM workspaces WHERE id = ?").get(l.workspaceId) as {
        tenant_id: string;
      }
    ).tenant_id;
    expect(calls).toEqual([
      {
        tenant_id: tenant,
        run_id: null,
        corpus: "retrospective",
        purpose: "index",
        service: "embedding",
        model: "embed-test",
        inputs: 3,
        input_tokens: 21,
        outcome: "ok",
      },
    ]);
    expect(embed.inputs).toEqual([
      [
        "Signed in through the login page.",
        "Wrote the report and the upload.",
        "login timeout on the login page",
      ],
    ]);
    expect(retro.status()).toMatchObject({ embeddingModel: "embed-test", embedded: 3, matched: 1 });

    // A second step finds nothing new and calls nothing.
    const again = retrospective(l.ctx, path, embed.fetchImpl);
    await again.retro.step();
    await again.sink.close();
    expect(embed.inputs).toHaveLength(1);
  });

  it("records a failed call and retries it on the next step", async () => {
    const l = await setup();
    const path = join(l.dir, "obs.sqlite");
    finishedRun(l.ctx, l, "succeeded", "login worked", at(1));
    const failing = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
    const first = retrospective(l.ctx, path, failing);
    await first.sink.ensureSchema();
    await expect(first.retro.step()).rejects.toThrow("503");
    expect(first.retro.status().lastError?.message).toContain("503");
    await first.sink.close();
    const embed = fakeEmbedding();
    const second = retrospective(l.ctx, path, embed.fetchImpl);
    await second.retro.step();
    await second.sink.close();
    expect(embed.inputs).toEqual([["login worked"]]);
    expect(
      l.ctx.db.prepare("SELECT outcome FROM retrieval_calls ORDER BY created_at, rowid").all(),
    ).toEqual([{ outcome: "error" }, { outcome: "ok" }]);
  });

  it("never sends, stores or offers a private chat's run", async () => {
    const l = await setup();
    const path = join(l.dir, "obs.sqlite");
    const stamp = new Date().toISOString();
    l.ctx.db
      .prepare(
        "INSERT INTO users (id, display_name, created_at, updated_at) VALUES ('usr_retro', 'Retro', ?, ?)",
      )
      .run(stamp, stamp);
    const privateThread = l.ctx.threads.create({
      workspaceId: l.workspaceId as never,
      botIds: [l.botId as never],
    });
    l.ctx.db
      .prepare("UPDATE threads SET private_to_user_id = 'usr_retro' WHERE id = ?")
      .run(privateThread.id);
    const hidden = finishedRun(
      l.ctx,
      { botId: l.botId, threadId: privateThread.id },
      "succeeded",
      "secret login secret login",
      at(1),
    );
    const shared = finishedRun(l.ctx, l, "succeeded", "report upload", at(2));
    const failedPrivate = finishedRun(
      l.ctx,
      { botId: l.botId, threadId: privateThread.id },
      "failed",
      "secret login timeout",
      at(3),
    );
    const failed = finishedRun(l.ctx, l, "failed", "secret login timeout", at(4));
    const embed = fakeEmbedding();
    const { sink, retro } = retrospective(l.ctx, path, embed.fetchImpl);
    await sink.ensureSchema();
    await retro.step();
    await sink.close();

    expect(embed.inputs.flat()).toEqual(["report upload", "secret login timeout"]);
    const db = new Database(path, { readonly: true });
    const stored = (
      db.prepare("SELECT run_id FROM run_vectors ORDER BY run_id").all() as {
        run_id: string;
      }[]
    ).map((r) => r.run_id);
    db.close();
    expect(stored).toEqual([failed, shared].sort());
    expect(stored).not.toContain(hidden);
    expect(stored).not.toContain(failedPrivate);
    expect(matchesOf(path, failed).map((m) => m.match_run_id)).toEqual([shared]);
    expect(matchesOf(path, failedPrivate)).toEqual([]);
  });

  it("matches only within the workspace, and never offers a run marked wrong", async () => {
    const l = await setup();
    const path = join(l.dir, "obs.sqlite");
    const other = await l.h.api<{ workspace: { id: string } }>("POST", "/api/workspaces", {
      name: "ws-2",
    });
    const otherBot = l.ctx.bots.create({
      name: "bob",
      role: "tester",
      workspaceId: other.json.workspace.id as never,
    });
    const otherThread = l.ctx.threads.create({
      workspaceId: other.json.workspace.id as never,
      botIds: [otherBot.id],
    });
    const elsewhere = finishedRun(
      l.ctx,
      { botId: otherBot.id, threadId: otherThread.id },
      "succeeded",
      "login timeout login timeout",
      at(1),
    );
    const wrong = finishedRun(l.ctx, l, "succeeded", "login timeout handled", at(2));
    const good = finishedRun(l.ctx, l, "succeeded", "report", at(3));
    l.ctx.db
      .prepare(
        `INSERT INTO run_marks (run_id, workspace_id, verdict, note, marked_by, marked_at)
         VALUES (?, ?, 'wrong', 'not actually done', 'user:usr_x', ?)`,
      )
      .run(wrong, l.workspaceId, at(2));
    const failed = finishedRun(l.ctx, l, "failed", "login timeout", at(4));
    const embed = fakeEmbedding();
    const { sink, retro } = retrospective(l.ctx, path, embed.fetchImpl);
    await sink.ensureSchema();
    await retro.step();
    await sink.close();
    const offered = matchesOf(path, failed).map((m) => m.match_run_id);
    expect(offered).toEqual([good]);
    expect(offered).not.toContain(wrong);
    expect(offered).not.toContain(elsewhere);
    // The other workspace's run is embedded, and is the other workspace's alone.
    expect(retro.status().embedded).toBe(4);
  });

  it("holds the walk for a pending summary, then skips the run once the wait has passed", async () => {
    const l = await setup();
    const path = join(l.dir, "obs.sqlite");
    const long = Array.from({ length: 60 }, (_, i) => `step${i}`).join(" ");
    const pending = finishedRun(l.ctx, l, "failed", long, at(1));
    l.ctx.db
      .prepare(
        `INSERT INTO run_activity_summaries (run_id, source_version, workspace_id, status, created_at, updated_at)
         VALUES (?, 'a1-failed', ?, 'pending', ?, ?)`,
      )
      .run(pending, l.workspaceId, at(1), at(1));
    const after = finishedRun(l.ctx, l, "succeeded", "report", at(2));
    const embed = fakeEmbedding();
    const early = () => new Date(Date.parse(at(1)) + SUMMARY_WAIT_MS - 60_000);
    const first = retrospective(l.ctx, path, embed.fetchImpl, early);
    await first.sink.ensureSchema();
    await first.retro.step();
    await first.sink.close();
    expect(embed.inputs).toEqual([]);
    expect(first.retro.status().position).toBeNull();

    const late = () => new Date(Date.parse(at(1)) + SUMMARY_WAIT_MS + 60_000);
    const second = retrospective(l.ctx, path, embed.fetchImpl, late);
    await second.retro.step();
    await second.sink.close();
    expect(embed.inputs).toEqual([["report"]]);
    expect(second.retro.status().position).toBe(`${at(2)} ${after}`);

    // A ready summary of the run's current version is what is embedded.
    const ready = finishedRun(l.ctx, l, "failed", long, at(3));
    l.ctx.db
      .prepare(
        `INSERT INTO run_activity_summaries (run_id, source_version, workspace_id, status, text, created_at, updated_at)
         VALUES (?, 'a1-failed', ?, 'ready', 'Gave up after the login timed out.', ?, ?)`,
      )
      .run(ready, l.workspaceId, at(3), at(3));
    const third = retrospective(l.ctx, path, embed.fetchImpl, late);
    await third.retro.step();
    await third.sink.close();
    expect(embed.inputs[1]).toEqual(["Gave up after the login timed out."]);
  });
});

describe("the retrospective in the observability module", () => {
  const settings = {
    sink: "sqlite" as const,
    batchSeconds: 300,
    batchBytes: 1 << 20,
    payloads: "full" as const,
    retrospective: true,
  };

  it("is off, and calls nothing, when no embedding service is configured or it is off", async () => {
    const l = await setup();
    finishedRun(l.ctx, l, "failed", "login timeout", at(1));
    const embed = fakeEmbedding();
    for (const [i, config] of [
      testConfig({ dbPath: join(l.dir, "a", "gateway.sqlite"), observability: settings }),
      testConfig({
        dbPath: join(l.dir, "b", "gateway.sqlite"),
        observability: { ...settings, retrospective: false },
        retrieval: RETRIEVAL,
      }),
    ].entries()) {
      const module = createObservabilityModule({
        db: l.ctx.db,
        config,
        now: LATER,
        fetch: embed.fetchImpl,
      });
      if (!module) throw new Error("module not created");
      await module.flush();
      expect((await module.status()).retrospective, String(i)).toBeNull();
      await module.stop();
    }
    expect(embed.inputs).toEqual([]);
    expect(l.ctx.db.prepare("SELECT count(*) AS n FROM retrieval_calls").get()).toEqual({ n: 0 });
  });

  it("runs after the collector, and failure_matches hides a match marked wrong later", async () => {
    const l = await setup();
    const now = new Date();
    const minute = (m: number) => new Date(now.getTime() - (60 - m) * 60_000).toISOString();
    const good = finishedRun(l.ctx, l, "succeeded", "login worked", minute(1));
    const other = finishedRun(l.ctx, l, "succeeded", "report upload", minute(2));
    const failed = finishedRun(l.ctx, l, "failed", "login timeout", minute(3));
    const embed = fakeEmbedding();
    const config = testConfig({
      dbPath: join(l.dir, "gateway.sqlite"),
      observability: settings,
      retrieval: RETRIEVAL,
    });
    const module = createObservabilityModule({
      db: l.ctx.db,
      config,
      now: LATER,
      fetch: embed.fetchImpl,
    });
    if (!module) throw new Error("module not created");
    await module.flush();
    expect((await module.status()).retrospective).toMatchObject({
      embeddingModel: "embed-test",
      embedded: 3,
      matched: 1,
      lastError: null,
    });
    const obsPath = join(l.dir, "obs.sqlite");
    const view = () => {
      const db = new Database(obsPath, { readonly: true });
      try {
        return db
          .prepare(
            "SELECT failed_run_id, failure_class, rank, match_run_id FROM failure_matches ORDER BY rank",
          )
          .all() as Array<{ failed_run_id: string; failure_class: string; match_run_id: string }>;
      } finally {
        db.close();
      }
    };
    expect(view().map((r) => r.match_run_id)).toEqual([good, other]);
    expect(view()[0]?.failed_run_id).toBe(failed);

    l.ctx.db
      .prepare(
        `INSERT INTO run_marks (run_id, workspace_id, verdict, note, marked_by, marked_at)
         VALUES (?, ?, 'wrong', NULL, 'user:usr_x', ?)`,
      )
      .run(good, l.workspaceId, new Date().toISOString());
    await module.flush();
    await module.stop();
    expect(view().map((r) => r.match_run_id)).toEqual([other]);
  });
});
