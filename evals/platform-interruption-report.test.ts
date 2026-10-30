// T1: the ADR-0029 decision 13 campaign report reads its five measures from a Gateway ledger alone:
// a ledger written by the real stores, on a migrated in-memory database.

import type { ApprovalId, RunId } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../packages/gateway/src/approvals/approvals.js";
import { openDatabase } from "../packages/gateway/src/db/open.js";
import { EventStore } from "../packages/gateway/src/ledger/events.js";
import { GatewayStartStore } from "../packages/gateway/src/ledger/gateway-starts.js";
import { RunStore } from "../packages/gateway/src/ledger/runs.js";
import {
  parseArgs,
  platformInterruptionReport,
  renderPlatformInterruptionMarkdown,
} from "./platform-interruption-report.js";

function ledger() {
  const db = openDatabase(":memory:");
  db.exec(
    "INSERT INTO workspaces (id, tenant_id, name, sandbox_provider, status, created_at) VALUES ('w', 'tnt_default', 'w', 'docker', 'ready', 't');" +
      "INSERT INTO bots (id, workspace_id, name, role, created_at) VALUES ('b', 'w', 'nova', 'r', 't');",
  );
  const runs = new RunStore(db);
  const events = new EventStore(db);
  const approvals = new ApprovalStore(db);
  const starts = new GatewayStartStore(db);
  const run = (status: "succeeded" | "failed" | "waiting_platform", error?: string): RunId => {
    const r = runs.create({
      botId: "b" as never,
      lane: "background",
      triggerKind: "webhook",
      triggerRef: `r-${Math.random()}`,
      triggerPayload: { body: "x" },
    });
    runs.transition(r.id, "running");
    if (status === "waiting_platform")
      runs.transition(r.id, "waiting_platform", {
        resumePayload: { sdkSessionId: "s", platform: "drain" },
      });
    else runs.transition(r.id, status, error ? { error } : {});
    return r.id;
  };
  const platform = (runId: RunId, op: string, ts: string, extra: Record<string, unknown> = {}) =>
    events.append({ runId, kind: "log", ts, payload: { source: "platform", op, ...extra } });
  return { db, runs, events, approvals, starts, run, platform };
}

describe("platform interruption report (ADR-0029 decision 13)", () => {
  it("lists killed, continued and succeeded runs, drain times and attempts per release", () => {
    const l = ledger();
    const drained = l.run("succeeded");
    const restarted = l.run("succeeded");
    const lost = l.run("failed", "gateway_restarted");
    const stillParked = l.run("waiting_platform");
    l.db
      .prepare("INSERT INTO gateway_drains (started_at, ended_at, release) VALUES (?, ?, ?)")
      .run("2026-10-17T10:00:00.000Z", "2026-10-17T10:02:00.000Z", "v0.8.0");
    l.db
      .prepare("INSERT INTO gateway_drains (started_at, release) VALUES (?, ?)")
      .run("2026-10-17T10:12:00.000Z", "v0.8.0");
    l.platform(drained, "parked", "2026-10-17T10:12:04.000Z", { reason: "drain" });
    l.platform(stillParked, "parked", "2026-10-17T10:12:30.000Z", { reason: "drain" });
    l.platform(drained, "resumed", "2026-10-17T10:15:00.000Z", { reason: "drain" });
    l.platform(restarted, "restart_found_live", "2026-10-17T10:14:00.000Z");
    l.platform(restarted, "parked", "2026-10-17T10:14:00.000Z", { reason: "restart" });
    l.platform(restarted, "resumed", "2026-10-17T10:14:01.000Z", { reason: "restart" });
    l.platform(lost, "restart_found_live", "2026-10-17T10:14:00.000Z");
    l.platform(lost, "failed", "2026-10-17T10:14:00.000Z", { reason: "restart" });

    const report = platformInterruptionReport(l.db);
    expect(report.killed).toEqual({ byRestart: 2, failedGatewayRestarted: 1 });
    expect(report.continued).toEqual({ runs: 2, succeeded: 2, successShare: 1 });
    expect(report.duplicateL2Effects).toEqual({ count: 0, approvalIds: [] });
    expect(report.drainToSafePointMs).toEqual({ parks: 2, p50: 4000, max: 30_000 });
    expect(report.upgradeAttempts).toEqual([{ release: "v0.8.0", drains: 2, endedUnforced: 1 }]);
    expect(renderPlatformInterruptionMarkdown(report)).toContain("Duplicate L2 effects: 0");
  });

  it("counts an approval that let two calls run to a result as a duplicate L2 effect", () => {
    const l = ledger();
    const runId = l.run("succeeded");
    l.approvals.create({
      id: "apr-twice" as ApprovalId,
      runId,
      botId: "b" as never,
      action: { toolName: "Bash", input: {}, argumentSummary: "pay" },
      riskLevel: "L2",
      toolUseId: "tu_1",
      decision: "allow_once",
      decidedBy: "human:usr",
    });
    l.events.append({ runId, kind: "tool_result", payload: { toolUseId: "tu_1", isError: false } });
    l.events.append({
      runId,
      kind: "approval",
      payload: { phase: "resumed", approvalId: "apr-twice", toolUseId: "tu_2" },
    });
    l.events.append({ runId, kind: "tool_result", payload: { toolUseId: "tu_2", isError: false } });
    expect(platformInterruptionReport(l.db).duplicateL2Effects).toEqual({
      count: 1,
      approvalIds: ["apr-twice"],
    });
  });

  it("reads its arguments", () => {
    expect(parseArgs(["--db", "x.sqlite", "--since", "2026-10-17", "--json"])).toEqual({
      db: "x.sqlite",
      since: "2026-10-17",
      json: true,
    });
    expect(() => parseArgs(["--nope"])).toThrow(/unknown argument/);
  });
});
