// T1: the ledger's event ordering when the sidecar and the Gateway both append to one run.

import type { RunId } from "@deskmates/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { type GatewayDb, openDatabase } from "../db/open.js";
import { EventStore } from "./events.js";

const RUN = "run_1" as RunId;

let db: GatewayDb;
let store: EventStore;

beforeEach(() => {
  db = openDatabase(":memory:");
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('w', 'tnt_default', 'w', 'docker', 'ready', 't')",
  ).run();
  db.prepare(
    "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('b', 'w', 'b', 'r', 't')",
  ).run();
  db.prepare(
    "INSERT INTO runs (workspace_id, id, bot_id, lane, status, trigger_kind, trigger_ref, created_at) VALUES ('w', ?, 'b', 'interactive', 'running', 'thread_message', 'm', 't')",
  ).run(RUN);
  store = new EventStore(db);
});

describe("EventStore", () => {
  it("keeps a sidecar event that arrives after a Gateway event took the next seq (the approval race)", () => {
    store.append({ runId: RUN, kind: "log", payload: { n: 1 }, seq: 1 });
    store.append({ runId: RUN, kind: "log", payload: { n: 2 }, seq: 2 });
    // The sidecar has emitted seq 3 ("approval requested") into its batch but not posted it yet;
    // its POST /approvals lands first and the Gateway records its own deny event.
    const deny = store.append({ runId: RUN, kind: "approval", payload: { decision: "deny" } });
    const requested = store.append({
      runId: RUN,
      kind: "approval",
      payload: { phase: "requested" },
      seq: 3,
    });

    expect(deny?.seq).toBe(3);
    expect(requested).toBeDefined();
    expect(requested?.seq).toBe(4);
    expect(requested?.sidecarSeq).toBe(3);
    expect(store.list(RUN).map((e) => [e.seq, e.kind, e.sidecarSeq])).toEqual([
      [1, "log", 1],
      [2, "log", 2],
      [3, "approval", undefined],
      [4, "approval", 3],
    ]);
  });

  it("drops a redelivered sidecar event and keeps the ledger seq monotonic", () => {
    store.append({ runId: RUN, kind: "log", payload: { n: 1 }, seq: 1 });
    store.append({ runId: RUN, kind: "log", payload: { n: 2 }, seq: 2 });
    expect(store.append({ runId: RUN, kind: "log", payload: { n: 2 }, seq: 2 })).toBeUndefined();
    expect(
      store
        .appendMany([
          { runId: RUN, kind: "log", payload: { n: 1 }, seq: 1 },
          { runId: RUN, kind: "log", payload: { n: 3 }, seq: 3 },
        ])
        .map((e) => e.seq),
    ).toEqual([3]);
    expect(store.list(RUN).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it("keys redelivery on (run, attempt, seq) so a resumed process's events are kept", () => {
    // A resumed run is a second sidecar process and its counter restarts at 1 (ADR-0002
    // amendment 2). Without `attempt` in the key its first event looks like a redelivery.
    const first = store.append({ runId: RUN, kind: "log", payload: { p: 1 }, seq: 1, attempt: 1 });
    const resumed = store.append({
      runId: RUN,
      kind: "log",
      payload: { p: 2 },
      seq: 1,
      attempt: 2,
    });
    expect([first?.seq, resumed?.seq]).toEqual([1, 2]);
    expect(resumed?.attempt).toBe(2);
    // A redelivered batch of the same attempt still is one.
    expect(
      store.append({ runId: RUN, kind: "log", payload: { p: 1 }, seq: 1, attempt: 1 }),
    ).toBeUndefined();
    expect(
      store.append({ runId: RUN, kind: "log", payload: { p: 2 }, seq: 1, attempt: 2 }),
    ).toBeUndefined();
    expect(store.list(RUN).map((e) => [e.seq, e.sidecarSeq, e.attempt])).toEqual([
      [1, 1, 1],
      [2, 1, 2],
    ]);
  });

  it("assigns Gateway-originated events consecutive seqs after any sidecar seq", () => {
    store.append({ runId: RUN, kind: "log", payload: {}, seq: 7 });
    const a = store.append({ runId: RUN, kind: "pricing_missing", payload: { model: "m" } });
    const b = store.append({ runId: RUN, kind: "pricing_missing", payload: { model: "n" } });
    expect([a?.seq, b?.seq]).toEqual([2, 3]);
  });

  it("stamps a Gateway-originated event with the run's current attempt", () => {
    // ADR-0002 amendment 2, "2, resume": events the Gateway appends itself (`resumed`, `decided`,
    // rule changes) carry the attempt the run is on, not a hardcoded 1.
    const before = store.append({ runId: RUN, kind: "approval", payload: { phase: "decided" } });
    expect(before?.attempt).toBe(1);
    db.prepare("UPDATE runs SET attempt = 2 WHERE id = ?").run(RUN);
    const after = store.appendMany([
      { runId: RUN, kind: "approval", payload: { phase: "resumed" } },
    ]);
    expect(after.map((e) => e.attempt)).toEqual([2]);
    // And it survives the round trip: every stored event reports an attempt.
    expect(store.list(RUN).map((e) => [e.seq, e.attempt])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });
});
