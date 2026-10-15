// T1 (ADR-0041 decisions 1, 5, 7 and 8): unconfigured search is byte-identical to the FTS5
// functions; configured search finds a related source with no shared word, never crosses a tenant
// or workspace, reranks the head, degrades on a failed call and records every call.

import type { WorkspaceId } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { RetrievalSettings } from "../config/retrieval.js";
import { RETRIEVAL_DEFAULTS } from "../config/retrieval.js";
import { searchMemory, searchMemoryPage } from "../memory/search.js";
import { forgetEntry } from "../memory/versions.js";
import {
  FAKE_EMBEDDING,
  FAKE_RERANK,
  FakeRetrievalService,
} from "../test-support/fake-retrieval.js";
import { type MemoryFixture, memoryFixture } from "../test-support/memory-fixture.js";
import { HybridRetrieval } from "./hybrid-retrieval.js";

const T = "tnt_default";
const OTHER = "tnt_other";

let f: MemoryFixture | undefined;
afterEach(async () => {
  await f?.close();
  f = undefined;
});

function publish(fx: MemoryFixture, tenantId: string, title: string, body: string): string {
  const store = fx.ctx.knowledge;
  return store.review(tenantId, store.propose(tenantId, title, body).id, "approve", "human:t")
    .documentId as string;
}

function note(fx: MemoryFixture, workspaceId: WorkspaceId, body: string): string {
  return fx.ctx.memory.entries.insert({
    workspaceId,
    scope: "workspace",
    kind: "note",
    body,
    authority: "fact",
    trust: "trusted",
    sourceKind: "human",
    by: "human:t",
  }).id;
}

async function seeded() {
  const fx = await memoryFixture();
  fx.ctx.db
    .prepare(
      "INSERT INTO tenants (id, name, created_at, updated_at) VALUES (?, 'Other', datetime(), datetime())",
    )
    .run(OTHER);
  const docs = {
    backup: publish(
      fx,
      T,
      "Database backups",
      "Run pg_dump nightly at 02:00 and copy it to the NAS.",
    ),
    lunch: publish(
      fx,
      T,
      "Cafeteria",
      "The cafeteria serves lunch from 11:30; the database of menus is online.",
    ),
    deploy: publish(fx, T, "Deploying", "Push a tag to release; the database migrates on start."),
    other: publish(fx, OTHER, "Other tenant backups", "Their pg_dump snapshot policy."),
  };
  const notes = {
    backup: note(fx, fx.a.workspace.id, "pg_dump runs nightly on the reporting host."),
    expense: note(fx, fx.a.workspace.id, "Expense reports over 500 need the finance lead."),
    plain: note(fx, fx.a.workspace.id, "The database host is db-3."),
    otherWorkspace: note(fx, fx.b.workspace.id, "Workspace B keeps its pg_dump snapshot on S3."),
  };
  f = fx;
  return { fx, docs, notes };
}

const settings = (over: Partial<RetrievalSettings> = {}): RetrievalSettings => ({
  embedding: FAKE_EMBEDDING,
  rerank: FAKE_RERANK,
  ...RETRIEVAL_DEFAULTS,
  ...over,
});

const QUERIES = [
  "database",
  "pg_dump",
  "lunch database",
  "nothing-matches",
  "备份",
  "?!",
  "release tag",
];

describe("unconfigured (decision 1)", () => {
  it("is byte-identical to the FTS5 functions and calls nothing", async () => {
    const { fx } = await seeded();
    const forbidden: typeof fetch = () => {
      throw new Error("no retrieval service may be called");
    };
    const plain = new HybridRetrieval({
      db: fx.ctx.db,
      knowledge: fx.ctx.knowledge,
      fetch: forbidden,
    });
    expect(plain.enabled).toBe(false);
    expect(plain.indexer).toBeUndefined();
    expect(plain.knobs()).toBeUndefined();
    // The Gateway's own instance is unconfigured in tests.
    expect(fx.ctx.retrieval.enabled).toBe(false);
    const ws = fx.a.workspace.id;
    const now = new Date();
    for (const q of QUERIES) {
      expect(JSON.stringify(await plain.knowledgeSearch(T, q))).toBe(
        JSON.stringify(fx.ctx.knowledge.search(T, q)),
      );
      expect(JSON.stringify(await plain.knowledgeSearch(T, q, { limit: 2, runId: "run_x" }))).toBe(
        JSON.stringify(fx.ctx.knowledge.search(T, q, 2)),
      );
      expect(JSON.stringify(await plain.knowledgeSearchPage(T, q, 1, 2))).toBe(
        JSON.stringify(fx.ctx.knowledge.searchPage(T, q, 1, 2)),
      );
      expect(JSON.stringify(await plain.memorySearch({ workspaceId: ws, query: q, now }))).toBe(
        JSON.stringify(searchMemory(fx.ctx.db, { workspaceId: ws, query: q, now })),
      );
      const page = { workspaceId: ws, query: q, limit: 1, offset: 1, now };
      expect(JSON.stringify(await plain.memorySearchPage(page))).toBe(
        JSON.stringify(searchMemoryPage(fx.ctx.db, page)),
      );
    }
    expect(() => plain.kick()).not.toThrow();
    const n = fx.ctx.db.prepare("SELECT count(*) AS n FROM retrieval_calls").get() as { n: number };
    expect(n.n).toBe(0);
  });
});

describe("configured (decisions 5, 7, 8)", () => {
  async function hybrid(over: Partial<RetrievalSettings> = {}) {
    const s = await seeded();
    const fake = new FakeRetrievalService();
    const retrieval = new HybridRetrieval({
      db: s.fx.ctx.db,
      knowledge: s.fx.ctx.knowledge,
      settings: settings(over),
      fetch: fake.fetch,
      queryTimeoutMs: 50,
    });
    const pass = await retrieval.indexer?.runOnce();
    expect(pass).toEqual({ knowledge: 4, memory: 4, failed: false });
    fake.calls.length = 0;
    return { ...s, fake, retrieval };
  }

  it("finds a related Knowledge document with no shared word, within the tenant only", async () => {
    const { docs, retrieval } = await hybrid();
    const query = "how do we back up our files";
    const hits = await retrieval.knowledgeSearch(T, query);
    expect(hits[0]?.id).toBe(docs.backup);
    expect(hits.map((hit) => hit.id)).not.toContain(docs.other);
    // The hit keeps the FTS5 hit shape.
    expect(Object.keys(hits[0] ?? {})).toEqual(["id", "title", "excerpt", "version"]);
    const page = await retrieval.knowledgeSearchPage(T, query, 0, 25);
    expect(page.total).toBe(page.items.length);
    expect(page.items.map((hit) => hit.id)).not.toContain(docs.other);
  });

  it("reranks lexical matches so the meaningful one leads", async () => {
    const { docs, retrieval, fx } = await hybrid();
    // bm25 alone ranks by the word "database", which all three share.
    const lexical = fx.ctx.knowledge.search(T, "database backup").map((hit) => hit.id);
    expect(lexical).toContain(docs.lunch);
    const hits = await retrieval.knowledgeSearch(T, "database backup");
    expect(hits[0]?.id).toBe(docs.backup);
  });

  it("finds related memory in the run's workspace only and drops forgotten notes", async () => {
    const { fx, notes, retrieval } = await hybrid();
    const ws = fx.a.workspace.id;
    const hits = await retrieval.memorySearch({ workspaceId: ws, query: "how is the backup made" });
    expect(hits[0]?.id).toBe(notes.backup);
    expect(hits.map((hit) => hit.id)).not.toContain(notes.otherWorkspace);
    forgetEntry(fx.ctx.memory.entries, ws, notes.backup, "human:t");
    const after = await retrieval.memorySearch({
      workspaceId: ws,
      query: "how is the backup made",
    });
    expect(after.map((hit) => hit.id)).not.toContain(notes.backup);
    const vectors = fx.ctx.db
      .prepare("SELECT count(*) AS n FROM memory_chunk_vectors WHERE entry_id = ?")
      .get(notes.backup) as { n: number };
    expect(vectors.n).toBe(0);
    // Paging over the fused list announces a further page.
    const first = await retrieval.memorySearchPage({
      workspaceId: ws,
      query: "database",
      limit: 1,
    });
    expect(first.hits).toHaveLength(1);
  });

  it("keeps empty and invalid queries as FTS5 does", async () => {
    const { retrieval, fake } = await hybrid();
    expect(await retrieval.knowledgeSearch(T, "?!")).toEqual([]);
    expect(
      await retrieval.memorySearch({ workspaceId: "ws_none" as WorkspaceId, query: "?!" }),
    ).toEqual([]);
    await expect(retrieval.knowledgeSearch(T, "x".repeat(501))).rejects.toThrow(/too long/);
    expect(fake.calls).toEqual([]);
  });

  it("degrades to bm25 when embedding fails and to the fused order when rerank fails", async () => {
    const { fx, retrieval, fake } = await hybrid();
    fake.failEmbed = "error";
    expect(await retrieval.knowledgeSearch(T, "how do we back up our files")).toEqual([]);
    const lexical = fx.ctx.knowledge.search(T, "database");
    fake.failRerank = "timeout";
    expect((await retrieval.knowledgeSearch(T, "database")).map((h) => h.id).sort()).toEqual(
      lexical.map((h) => h.id).sort(),
    );
    const outcomes = fx.ctx.db
      .prepare(
        "SELECT service, outcome FROM retrieval_calls WHERE purpose = 'query' ORDER BY rowid",
      )
      .all();
    expect(outcomes).toEqual([
      { service: "embedding", outcome: "error" },
      { service: "embedding", outcome: "error" },
      { service: "rerank", outcome: "timeout" },
    ]);
  });

  it("records each call with tokens, attributed to the asking run", async () => {
    const { fx, retrieval } = await hybrid();
    const runId = fx.run();
    await retrieval.knowledgeSearch(T, "database backup", { runId });
    await retrieval.memorySearch({
      runId,
      workspaceId: fx.a.workspace.id,
      query: "backup database",
    });
    const calls = retrieval.usage.forRun(runId);
    expect(calls.map((c) => [c.corpus, c.service, c.purpose, c.outcome])).toEqual([
      ["knowledge", "embedding", "query", "ok"],
      ["knowledge", "rerank", "query", "ok"],
      ["memory", "embedding", "query", "ok"],
      ["memory", "rerank", "query", "ok"],
    ]);
    expect(calls.every((c) => c.tenantId === T && c.inputTokens !== null)).toBe(true);
    const summary = retrieval.usage.summary(T, new Date(0));
    const index = summary.find((row) => row.purpose === "index");
    expect(index).toMatchObject({ service: "embedding", outcome: "ok", unknownTokenCalls: 0 });
    expect(retrieval.knobs()).toMatchObject({
      version: 1,
      embeddingModel: "fake-embed",
      rerankModel: "fake-rerank",
      rrfK: 60,
    });
  });
});
