// T1, ADR-0046 decision 8: `GET /api/observability/status` is the root's alone; it reports the
// sink, received and committed watermarks per table, the newest batch and its age, the spool and
// the last error; with no sink it says `enabled: false`. `GET /api/config` hands the web the
// same-origin relay `/analytics/` as `analyticsUrl` when `OBSERVABILITY_GRAFANA_URL` is set, or
// null, so the Analytics entry can hide (amendment 1 decision 16).

import { join } from "node:path";
import type { ObservabilityStatus, OperatorConfig } from "@deskmates/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayConfig } from "../config.js";
import { observabilityOf } from "../observability/observability-module.js";
import { type Harness, startHarness } from "../test-support/harness.js";
import { seedRun, tempDir } from "../test-support/observability-ledger.js";

let h: Harness | undefined;
const cleanup: Array<() => void> = [];
afterEach(async () => {
  await h?.close();
  h = undefined;
  for (const c of cleanup.splice(0)) c();
});

function observed(extra: Partial<GatewayConfig> = {}): Partial<GatewayConfig> {
  const t = tempDir("obs-route");
  cleanup.push(t.remove);
  return {
    observability: {
      sink: "sqlite",
      sqlitePath: join(t.dir, "obs.sqlite"),
      batchSeconds: 300,
      batchBytes: 1 << 20,
      payloads: "derived",
      retrospective: true,
    },
    observabilityGrafanaUrl: "http://127.0.0.1:18700",
    ...extra,
  };
}

describe("GET /api/observability/status (ADR-0046 decision 8)", () => {
  it("says the pipeline is off when no sink is configured", async () => {
    h = await startHarness({ observabilityGrafanaUrl: "http://127.0.0.1:18700" });
    const res = await h.api<ObservabilityStatus>("GET", "/api/observability/status");
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      enabled: false,
      grafanaUrl: "http://127.0.0.1:18700",
      sink: null,
      tables: [],
      lastError: null,
    });
  });

  it("reports watermarks, the newest batch, the spool and the sink", async () => {
    h = await startHarness(observed());
    h.app.deskmates.scheduler.stop();
    const { bot, thread, workspace } = await h.seed();
    const ctx = h.app.deskmates.ctx;
    const module = observabilityOf(ctx);
    expect(module).toBeDefined();
    const before = await h.api<ObservabilityStatus>("GET", "/api/observability/status");
    expect(before.json).toMatchObject({
      enabled: true,
      sink: { id: "sqlite", engine: "sqlite", contractVersion: 2 },
      payloads: "derived",
      // No embedding service is configured, so the retrospective does not run.
      retrospective: null,
      batchSeconds: 300,
      retentionDays: null,
      newestBatch: null,
      lastError: null,
    });
    expect(before.json.tables.find((t) => t.table === "run_events")).toEqual({
      table: "run_events",
      received: null,
      committed: null,
    });
    seedRun(ctx, { botId: bot.id, threadId: thread.id, workspaceId: workspace.id });
    // The rows are newer than the settle window; wait it out rather than move a clock.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await module?.tick();
    const open = await h.api<ObservabilityStatus>("GET", "/api/observability/status");
    const lastEvent = String(
      (ctx.db.prepare("SELECT max(id) AS id FROM run_events").get() as { id: number }).id,
    );
    expect(open.json.openBatch).toMatchObject({ batchId: "000000000001" });
    expect(open.json.spoolBytes).toBeGreaterThan(0);
    expect(open.json.tables.find((t) => t.table === "run_events")).toEqual({
      table: "run_events",
      received: lastEvent,
      committed: null,
    });
    await module?.flush();
    const done = await h.api<ObservabilityStatus>("GET", "/api/observability/status");
    expect(done.json.tables.find((t) => t.table === "run_events")).toEqual({
      table: "run_events",
      received: lastEvent,
      committed: lastEvent,
    });
    expect(done.json.newestBatch).toMatchObject({ batchId: "000000000001", committed: true });
    expect(done.json.newestBatch?.ageSeconds).toBeGreaterThanOrEqual(0);
    expect(done.json.openBatch).toBeNull();
    expect(done.json.pendingBatches).toBe(0);
    expect(done.json.sinkStats?.bytes).toBeGreaterThan(0);
  });

  it("reports the last error", async () => {
    h = await startHarness(observed());
    const module = observabilityOf(h.app.deskmates.ctx);
    // A closed sink cannot prepare its schema: the next step fails and the status says why.
    await module?.stop();
    await expect(module?.tick()).rejects.toThrow();
    const res = await h.api<ObservabilityStatus>("GET", "/api/observability/status");
    expect(res.json.lastError?.message).toMatch(/not open/);
    expect(res.json.lastError?.at).toBeTypeOf("string");
  });

  it("is the root's alone: a service principal is refused", async () => {
    h = await startHarness(observed());
    const created = await h.api<{ token: string }>("POST", "/api/service-principals", {
      name: "obs-reader",
    });
    expect(created.status).toBe(201);
    const res = await fetch(`${h.baseUrl}/api/observability/status`, {
      headers: { authorization: `Bearer ${created.json.token}` },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe(
      "root_only",
    );
  });
});

describe("GET /api/config analyticsUrl (ADR-0046 decision 8, amendment 1 decision 16)", () => {
  it("is the same-origin relay when OBSERVABILITY_GRAFANA_URL is set, null otherwise", async () => {
    h = await startHarness({ observabilityGrafanaUrl: "http://127.0.0.1:18700" });
    const config = await h.api<OperatorConfig>("GET", "/api/config");
    expect(config.json.analyticsUrl).toBe("/analytics/");
    // Grafana's own address is the relay's upstream; it never reaches the web here.
    expect(JSON.stringify(config.json)).not.toContain("18700");
    await h.close();
    h = await startHarness();
    expect((await h.api<OperatorConfig>("GET", "/api/config")).json.analyticsUrl).toBeNull();
  });
});
