// T0: the continuation decision is atomic with its run transition, without a Gateway server.
import type { ApprovalId, BotId, RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/open.js";
import { EventBus } from "../events/bus.js";
import { EventStore } from "../ledger/events.js";
import { RunStore } from "../ledger/runs.js";
import { ApprovalStore } from "./approvals.js";
import { ApprovalBroker, type BrokerDeps } from "./broker.js";

function setup(count = 0, expiresAt = "2099-01-01T00:00:00.000Z") {
  const db = openDatabase(":memory:");
  const ts = "2026-09-30T00:00:00.000Z";
  db.prepare(
    "INSERT INTO workspaces (id, tenant_id,name,sandbox_provider,status,created_at) VALUES ('ws', 'tnt_default','Work','docker','ready',?)",
  ).run(ts);
  db.prepare(
    "INSERT INTO bots (id,name,role,workspace_id,created_at) VALUES ('bot','bot','role','ws',?)",
  ).run(ts);
  const runs = new RunStore(db);
  const approvals = new ApprovalStore(db);
  const run = runs.create({
    botId: "bot" as BotId,
    lane: "background",
    triggerKind: "webhook",
    triggerRef: "task",
  });
  const id = "approval-continuation" as ApprovalId;
  runs.transition(run.id, "running");
  runs.setConfig(run.id, {
    continuationCount: count,
    continuationExpiresAt: expiresAt,
    handoffPath: "/work/handoff.md",
  });
  runs.transition(run.id, "waiting_continuation", {
    resumePayload: { sdkSessionId: "session", approvalId: id, continuation: true },
  });
  approvals.create({
    id,
    runId: run.id,
    botId: "bot" as BotId,
    action: { toolName: "__run_continuation__", input: {} },
    riskLevel: "L0",
  });
  // This no-thread test exercises the real stores and bus; unrelated collaborators are unused.
  const deps = {
    approvals,
    runs,
    events: new EventStore(db),
    bus: new EventBus(),
    router: { runEnded: () => [] },
    messages: {},
    rules: {},
    bots: {},
    presence: {},
  } as unknown as BrokerDeps;
  return { db, runs, approvals, broker: new ApprovalBroker(deps), runId: run.id as RunId, id };
}

describe("continuation decisions", () => {
  it("continues the same run and leaves its attempt for the scheduler to increment", () => {
    const h = setup();
    try {
      h.broker.decide(h.id, "allow_once", "human:alice");
      expect(h.runs.mustGet(h.runId)).toMatchObject({ status: "waiting_continuation", attempt: 1 });
      expect(h.runs.mustGet(h.runId).config.continuationCount).toBe(1);
      expect(h.runs.listResumable().map((run) => run.id)).toEqual([h.runId]);
    } finally {
      h.db.close();
    }
  });

  it("stops with a handoff and cannot spend an approval on a stale run", () => {
    const h = setup();
    try {
      h.broker.decide(h.id, "deny", "human:alice");
      expect(h.runs.mustGet(h.runId).status).toBe("stopped");
      expect(h.runs.mustGet(h.runId).summary?.done).toContain("/work/handoff.md");
      expect(() => h.broker.decide(h.id, "allow_once", "human:bob")).toThrow();
    } finally {
      h.db.close();
    }
  });

  it("refuses expired and over-limit continuation without consuming the decision", () => {
    for (const [count, expiry] of [
      [0, "2000-01-01T00:00:00.000Z"],
      [2, "2099-01-01T00:00:00.000Z"],
    ] as const) {
      const h = setup(count, expiry);
      try {
        expect(() => h.broker.decide(h.id, "allow_once", "human:alice")).toThrow();
        expect(h.approvals.mustGet(h.id).decision).toBeUndefined();
        expect(h.runs.mustGet(h.runId).status).toBe("waiting_continuation");
      } finally {
        h.db.close();
      }
    }
  });
});
