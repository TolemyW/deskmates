// Seeding one retrieval campaign stack (protocol of 2026-10-17, comparison R) and reading one run
// back into an observation. T3/T4 support: used only by `retrieval-campaign.acceptance.test.ts`.
// Knowledge goes in the way an operator publishes it (propose, approve); learned memory as
// trusted human notes, the gold ones older than every filler so the pinned index holds filler.

import type { RunEvent, WorkspaceId } from "@deskmates/contracts";
import { runEvents, toolCalls } from "../../acceptance/support/runs.js";
import type { Stack } from "../../acceptance/support/start-stack.js";
import { fillerKnowledge, fillerNotes } from "../campaign/text.js";
import type { RetrievalObservation } from "./grade.js";
import type { RetrievalTaskSet } from "./task-set.js";

const DAY = 86_400_000;

/** Fixture id ↔ Gateway id of every seeded source. */
export interface SeedMap {
  toReal: Map<string, string>;
  toFixture: Map<string, string>;
}

function record(map: SeedMap, fixture: string, real: string): void {
  map.toReal.set(fixture, real);
  map.toFixture.set(real, fixture);
}

async function publish(stack: Stack, title: string, body: string): Promise<string> {
  const proposed = await stack.api<{ proposal: { id: string } }>(
    "POST",
    "/api/knowledge/proposals",
    { title, body },
  );
  if (proposed.status !== 201) throw new Error(`propose ${title}: ${proposed.status}`);
  const reviewed = await stack.api<{ proposal: { documentId?: string } }>(
    "POST",
    `/api/knowledge/proposals/${proposed.json.proposal.id}/review`,
    { decision: "approve", authorId: "retrieval-eval" },
  );
  const id = reviewed.json.proposal?.documentId;
  if (reviewed.status !== 200 || !id) throw new Error(`approve ${title}: ${reviewed.status}`);
  return id;
}

/**
 * Publish the Knowledge corpus, insert the memory corpus into the stack's workspace and the decoy
 * note into a second workspace, and switch off the automatic memory jobs so no cheap-model run
 * starts on its own. Returns the id map.
 */
export async function seedRetrieval(
  stack: Stack,
  set: RetrievalTaskSet,
  now = Date.now(),
): Promise<SeedMap> {
  const map: SeedMap = { toReal: new Map(), toFixture: new Map() };
  const ctx = stack.app.deskmates.ctx;
  for (const doc of [
    ...set.corpus.knowledge,
    ...fillerKnowledge(set.filler.knowledge, set.filler.seed),
  ])
    record(map, doc.id, await publish(stack, doc.title, doc.body));
  const note = (workspaceId: WorkspaceId, id: string, body: string, observedAt: number) =>
    record(
      map,
      id,
      ctx.memory.entries.insert({
        workspaceId,
        scope: "workspace",
        kind: "note",
        body,
        authority: "fact",
        trust: "trusted",
        sourceKind: "human",
        by: "fixture:retrieval-eval",
        observedAt: new Date(observedAt).toISOString(),
      }).id,
    );
  set.corpus.memory.forEach((n, i) =>
    note(stack.workspace.id, n.id, n.body, now - 60 * DAY + i * 60_000),
  );
  fillerNotes(set.filler.memory, set.filler.seed).forEach((n, i) =>
    note(stack.workspace.id, n.id, n.body, now - DAY + i * 1000),
  );
  const decoy = await stack.api<{ workspace: { id: WorkspaceId } }>("POST", "/api/workspaces", {
    defaultBot: false,
    name: "retrieval-eval-decoy",
    egressAllowlist: [],
  });
  if (decoy.status !== 201) throw new Error(`decoy workspace: ${decoy.status}`);
  for (const n of set.decoy.memory) note(decoy.json.workspace.id, n.id, n.body, now - 2 * DAY);
  for (const id of [stack.workspace.id, decoy.json.workspace.id]) {
    const res = await stack.api("PUT", `/api/workspaces/${id}/memory/maintenance`, {
      recheckDailyLimit: 0,
      organizeDaily: false,
    });
    if (res.status !== 200) throw new Error(`memory maintenance off: ${res.status}`);
  }
  return map;
}

/** Whether every seeded source of the stack's scope has a vector of the configured model. */
export function vectorsReady(stack: Stack, set: RetrievalTaskSet): boolean {
  const model = stack.config.retrieval?.embedding?.model;
  if (!model) return true;
  const db = stack.app.deskmates.ctx.db;
  const docs = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT document_id) AS n FROM knowledge_chunk_vectors WHERE model = ?",
      )
      .get(model) as { n: number }
  ).n;
  const notes = (
    db
      .prepare(
        "SELECT COUNT(DISTINCT entry_id) AS n FROM memory_chunk_vectors WHERE model = ? AND workspace_id = ?",
      )
      .get(model, stack.workspace.id) as { n: number }
  ).n;
  return (
    docs >= set.corpus.knowledge.length + set.filler.knowledge &&
    notes >= set.corpus.memory.length + set.filler.memory
  );
}

/** The fixture ids a search returned, in rank order, from the run's own ledger. */
function searchHits(events: readonly RunEvent[], map: SeedMap): string[][] {
  const hits: string[][] = [];
  for (const call of toolCalls(events, "knowledge_search")) {
    const result = events.find(
      (e) => e.kind === "tool_result" && e.payload.toolUseId === call.payload.toolUseId,
    );
    const content =
      typeof result?.payload.content === "string"
        ? result.payload.content
        : JSON.stringify(result?.payload.content ?? "");
    const found = [...map.toFixture.keys()]
      .map((real) => ({ real, at: content.indexOf(real) }))
      .filter((h) => h.at >= 0)
      .sort((a, b) => a.at - b.at)
      .map((h) => map.toFixture.get(h.real) as string);
    hits.push(found);
  }
  for (const log of events.filter(
    (e) => e.kind === "log" && e.payload.source === "memory_search",
  )) {
    const entries = Array.isArray(log.payload.entries)
      ? (log.payload.entries as { id?: unknown }[])
      : [];
    hits.push(entries.map((e) => map.toFixture.get(String(e.id)) ?? "?"));
  }
  return hits;
}

/** Everything of one finished run the grader needs, from the ledger only. */
export async function observeRetrievalRun(
  stack: Stack,
  set: RetrievalTaskSet,
  map: SeedMap,
  runId: string,
): Promise<
  Pick<
    RetrievalObservation,
    "status" | "finalReply" | "toolCalls" | "hits" | "canarySeen" | "memoryWrites"
  >
> {
  const ctx = stack.app.deskmates.ctx;
  const run = ctx.runs.mustGet(runId as Parameters<typeof ctx.runs.mustGet>[0]);
  const events = await runEvents(stack, runId);
  const reply = run.summary?.reply ?? null;
  const results = events
    .filter((e) => e.kind === "tool_result")
    .map((e) => JSON.stringify(e.payload));
  const writes = ctx.db
    .prepare("SELECT id FROM memory_entries WHERE source_run_id = ? AND tombstoned = 0")
    .all(runId) as { id: string }[];
  // Learned memory is a frozen snapshot (measurement §8): what this run wrote is forgotten.
  for (const w of writes) await stack.api("POST", `/api/memory/entries/${w.id}/forget`, {});
  return {
    status: run.status,
    finalReply: reply,
    toolCalls: Object.fromEntries(
      ["knowledge_search", "knowledge_read", "memory_search"].map((t) => [
        t,
        toolCalls(events, t).length,
      ]),
    ),
    hits: searchHits(events, map),
    canarySeen: [...results, reply ?? ""].some((text) => text.includes(set.decoy.canary)),
    memoryWrites: writes.length,
  };
}
