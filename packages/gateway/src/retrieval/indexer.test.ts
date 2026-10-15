// T1 (ADR-0041 decisions 3 and 4): the indexer embeds missing sources in batches of at most 16
// inputs per scope, skips a source whose text changed meanwhile, and a vector never outlives the
// text it came from (changed, forgotten, distilled, workspace deleted).

import type { WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { RETRIEVAL_DEFAULTS } from "../config/retrieval.js";
import {
  FAKE_EMBEDDING,
  FAKE_RERANK,
  FakeRetrievalService,
} from "../test-support/fake-retrieval.js";
import { type MemoryFixture, memoryFixture } from "../test-support/memory-fixture.js";
import { EmbeddingClient } from "./clients.js";
import { HybridRetrieval } from "./hybrid-retrieval.js";
import { RetrievalIndexer } from "./indexer.js";

const T = "tnt_default";
let f: MemoryFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

async function setup() {
  f = await memoryFixture();
  const fake = new FakeRetrievalService();
  const retrieval = new HybridRetrieval({
    db: f.ctx.db,
    knowledge: f.ctx.knowledge,
    settings: { embedding: FAKE_EMBEDDING, ...RETRIEVAL_DEFAULTS },
    fetch: fake.fetch,
  });
  const note = (workspaceId: WorkspaceId, body: string) =>
    (f as MemoryFixture).ctx.memory.entries.insert({
      workspaceId,
      scope: "workspace",
      kind: "note",
      body,
      authority: "fact",
      trust: "trusted",
      sourceKind: "human",
      by: "human:t",
    }).id;
  const indexer = retrieval.indexer as RetrievalIndexer;
  return { fx: f, fake, retrieval, indexer, note };
}

const count = (fx: MemoryFixture, table: string, where = "1 = 1", ...args: unknown[]) =>
  (
    fx.ctx.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...args) as {
      n: number;
    }
  ).n;

describe("indexer", () => {
  it("backfills in batches of at most 16 inputs, one scope per batch", async () => {
    const { fx, fake, indexer, note } = await setup();
    for (let i = 0; i < 20; i += 1) note(fx.a.workspace.id, `note a ${i} pg_dump`);
    for (let i = 0; i < 3; i += 1) note(fx.b.workspace.id, `note b ${i}`);
    const long = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ${"x".repeat(400)}`).join(
      "\n\n",
    );
    const store = fx.ctx.knowledge;
    store.review(T, store.propose(T, "Long", long).id, "approve", "human:t");
    expect(await indexer.runOnce()).toEqual({ knowledge: 1, memory: 23, failed: false });
    const embeds = fake.embedCalls();
    expect(embeds.every((call) => (call.body.input as string[]).length <= 16)).toBe(true);
    // Workspace a's 20 notes take two calls, b's 3 one: no batch mixes workspaces.
    const memoryInputs = embeds
      .map((call) => call.body.input as string[])
      .filter((input) => input.every((text) => text.startsWith("note ")));
    expect(memoryInputs.map((input) => input.length).sort((x, y) => x - y)).toEqual([3, 4, 16]);
    // The long document's chunks all start with its title.
    const docInputs = embeds
      .flatMap((call) => call.body.input as string[])
      .filter((t) => t.startsWith("Long\n"));
    expect(docInputs.length).toBeGreaterThan(5);
    expect(count(fx, "knowledge_chunk_vectors")).toBe(docInputs.length);
    // Nothing left: a second pass calls nothing.
    fake.calls.length = 0;
    expect(await indexer.runOnce()).toEqual({ knowledge: 0, memory: 0, failed: false });
    expect(fake.calls).toEqual([]);
    const rows = fx.ctx.db
      .prepare("SELECT purpose, inputs, input_tokens FROM retrieval_calls WHERE corpus = 'memory'")
      .all();
    expect(rows).toHaveLength(3);
    expect(rows).toContainEqual({ purpose: "index", inputs: 16, input_tokens: 48 });
    expect(rows).toContainEqual({ purpose: "index", inputs: 3, input_tokens: 9 });
  });

  it("deletes vectors when the text changes, is forgotten or distilled, and re-embeds", async () => {
    const { fx, indexer, note } = await setup();
    const id = note(fx.a.workspace.id, "pg_dump nightly");
    const gone = note(fx.a.workspace.id, "to be distilled");
    const store = fx.ctx.knowledge;
    const doc = store.review(T, store.propose(T, "Backups", "pg_dump").id, "approve", "human:t")
      .documentId as string;
    await indexer.runOnce();
    expect(count(fx, "memory_chunk_vectors")).toBe(2);
    fx.ctx.memory.entries.appendVersion(id, "edit", { body: "pg_dump hourly" }, "human:t");
    expect(count(fx, "memory_chunk_vectors", "entry_id = ?", id)).toBe(0);
    fx.ctx.db.prepare("UPDATE memory_entries SET episode_id = ? WHERE id = ?").run(id, gone);
    expect(count(fx, "memory_chunk_vectors", "entry_id = ?", gone)).toBe(0);
    store.edit(T, doc, "Backups", "pg_dump at 02:00", 1, "human:t");
    expect(count(fx, "knowledge_chunk_vectors")).toBe(0);
    // A title-only change also invalidates.
    await indexer.runOnce();
    expect(count(fx, "knowledge_chunk_vectors")).toBe(1);
    store.edit(T, doc, "Nightly backups", "pg_dump at 02:00", 2, "human:t");
    expect(count(fx, "knowledge_chunk_vectors")).toBe(0);
    // The edited entry was re-embedded; the distilled one is not searchable and stays out.
    expect(count(fx, "memory_chunk_vectors", "entry_id = ?", id)).toBe(1);
    expect(count(fx, "memory_chunk_vectors", "entry_id = ?", gone)).toBe(0);
  });

  it("skips a source whose body changed while it was embedded", async () => {
    const { fx, fake, retrieval, note } = await setup();
    const id = note(fx.a.workspace.id, "original body");
    const racing = new RetrievalIndexer(
      retrieval.vectors,
      new EmbeddingClient(FAKE_EMBEDDING, async (input, init) => {
        fx.ctx.db.prepare("UPDATE memory_entries SET body = 'changed body' WHERE id = ?").run(id);
        return fake.fetch(input, init);
      }),
      retrieval.usage,
    );
    // The first call embeds the old text and its write is skipped; the source is pending again
    // and the same pass embeds the new text.
    expect(await racing.runOnce()).toEqual({ knowledge: 0, memory: 1, failed: false });
    expect(fake.embedCalls().map((call) => call.body.input)).toEqual([
      ["original body"],
      ["changed body"],
    ]);
    expect(count(fx, "memory_chunk_vectors", "entry_id = ?", id)).toBe(1);
  });

  it("ends a pass on a failure, retries later, and drops vectors of another model", async () => {
    const { fx, fake, indexer, note, retrieval } = await setup();
    note(fx.a.workspace.id, "pg_dump");
    fake.failEmbed = "error";
    expect(await indexer.runOnce()).toEqual({ knowledge: 0, memory: 0, failed: true });
    expect(count(fx, "retrieval_calls", "outcome = 'error'")).toBe(1);
    fake.failEmbed = undefined;
    expect((await indexer.runOnce()).memory).toBe(1);
    fx.ctx.db.prepare("UPDATE memory_chunk_vectors SET model = 'old-model'").run();
    expect((await indexer.runOnce()).memory).toBe(1);
    expect(count(fx, "memory_chunk_vectors", "model = 'old-model'")).toBe(0);
    // A refused input is not retried in this process.
    note(fx.a.workspace.id, "refused input");
    fake.failEmbed = "refuse";
    expect((await indexer.runOnce()).failed).toBe(true);
    fake.calls.length = 0;
    expect((await indexer.runOnce()).failed).toBe(false);
    expect(fake.calls).toEqual([]);
    expect(retrieval.vectors.counts().memory).toBe(1);
  });

  it("starts, kicks and stops without waiting for a hung service", async () => {
    const { fx, fake, indexer, note } = await setup();
    note(fx.a.workspace.id, "pg_dump");
    fake.failEmbed = "timeout";
    indexer.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = Date.now();
    await indexer.stop();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(count(fx, "memory_chunk_vectors")).toBe(0);
  });
});

it("rerank alone reorders the FTS5 candidates and never embeds", async () => {
  f = await memoryFixture();
  const fake = new FakeRetrievalService();
  const retrieval = new HybridRetrieval({
    db: f.ctx.db,
    knowledge: f.ctx.knowledge,
    settings: { rerank: FAKE_RERANK, ...RETRIEVAL_DEFAULTS },
    fetch: fake.fetch,
  });
  expect(retrieval.indexer).toBeUndefined();
  const store = f.ctx.knowledge;
  const publish = (title: string, body: string) =>
    store.review(T, store.propose(T, title, body).id, "approve", "human:t").documentId as string;
  publish("Lunch", "The database of lunch menus.");
  const backup = publish("Snapshots", "The database is copied with pg_dump.");
  const hits = await retrieval.knowledgeSearch(T, "database backup");
  expect(hits[0]?.id).toBe(backup);
  expect(fake.embedCalls()).toEqual([]);
  expect(fake.rerankCalls()).toHaveLength(1);
});
