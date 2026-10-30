// T1, ADR-0046 amendment 2 decisions 19 to 22: the views the focus dashboards read, fed from a
// ledger through the collector into a real `obs.sqlite`. A request whose provider reported no
// cache-read count is `not_reported` with no share, never a miss or a 0 % hit rate; a model proxy
// span's own model is used for latency, the run's model only for an older span; and approval
// requests show pending, expired and who decided.

import { join } from "node:path";
import type { RunId } from "@deskmates/contracts";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { testConfig } from "../test-support/harness.js";
import { LATER, ledgerHarness, seedRun, tempDir } from "../test-support/observability-ledger.js";
import { createObservabilityModule } from "./observability-module.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

async function collected(seed: (l: Awaited<ReturnType<typeof ledgerHarness>>) => void) {
  const l = await ledgerHarness();
  cleanup.push(() => l.h.close());
  const t = tempDir("obs-views");
  cleanup.push(t.remove);
  seed(l);
  const config = testConfig({
    dbPath: join(t.dir, "gateway.sqlite"),
    observability: {
      sink: "sqlite",
      batchSeconds: 300,
      batchBytes: 1 << 20,
      payloads: "full",
      retrospective: true,
    },
  });
  const module = createObservabilityModule({ db: l.ctx.db, config, now: LATER });
  if (!module) throw new Error("module not created");
  await module.flush();
  await module.stop();
  const obs = new Database(join(t.dir, "obs.sqlite"), { readonly: true });
  cleanup.push(() => {
    obs.close();
  });
  return { l, obs };
}

describe("the focus dashboards' views (ADR-0046 amendment 2)", () => {
  it("a NULL cache count is not reported, never 0 %", async () => {
    let run = "" as RunId;
    const { obs } = await collected((l) => {
      run = seedRun(l.ctx, l);
      const request = (usage: Record<string, number> | null, refusal?: string) => {
        const id = l.ctx.modelRequests.insert({
          runId: run,
          attempt: 1,
          ts: new Date().toISOString(),
          requestKind: "messages",
          model: "model-a",
          stream: true,
          ...(refusal ? { refusal } : {}),
        } as never);
        if (usage) l.ctx.modelRequests.setUsage(id, usage as never);
      };
      request({ inputTokens: 900, outputTokens: 10 }); // the provider said nothing about the cache
      request({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 0 });
      request({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreateTokens: 40 });
      request(null);
      request(null, "model_not_selected");
    });
    const rows = obs
      .prepare(
        "SELECT cache_status, cache_reported, reported_prompt_tokens, cache_read_share FROM request_cache ORDER BY request_id",
      )
      .all();
    expect(rows).toEqual([
      // seedRun's request: 100 input, 50 read from the cache.
      {
        cache_status: "hit",
        cache_reported: 1,
        reported_prompt_tokens: 150,
        cache_read_share: 50 / 150,
      },
      {
        cache_status: "not_reported",
        cache_reported: 0,
        reported_prompt_tokens: null,
        cache_read_share: null,
      },
      { cache_status: "miss", cache_reported: 1, reported_prompt_tokens: 100, cache_read_share: 0 },
      {
        cache_status: "write",
        cache_reported: 1,
        reported_prompt_tokens: 140,
        cache_read_share: 0,
      },
      {
        cache_status: "no_usage",
        cache_reported: 0,
        reported_prompt_tokens: null,
        cache_read_share: null,
      },
      {
        cache_status: "refused",
        cache_reported: 0,
        reported_prompt_tokens: null,
        cache_read_share: null,
      },
    ]);
    // The share the Prompt cache dashboard computes: reported requests only. Counting the
    // not-reported request's 900 tokens would have read as a far lower hit rate.
    const share = obs
      .prepare(
        "SELECT 1.0 * sum(cache_read_tokens) / sum(reported_prompt_tokens) AS share FROM request_cache WHERE cache_reported = 1",
      )
      .get() as { share: number };
    expect(share.share).toBeCloseTo(50 / 390);
  });

  it("latency uses the span's model, and the run's model for an older span", async () => {
    const { obs } = await collected((l) => {
      const run = seedRun(l.ctx, l);
      const at = new Date().toISOString();
      const span = (
        spanId: string,
        phase: string,
        durationMs: number,
        extra: Record<string, unknown> = {},
      ) => ({
        runId: run,
        kind: "log" as const,
        payload: {
          source: "phase_timing",
          version: 1,
          spanId,
          phase,
          edge: "end",
          at,
          durationMs,
          outcome: "ok",
          requestKind: "messages",
          ...extra,
        },
      });
      l.ctx.events.appendMany([
        span("req-1", "model_request", 900, { model: "model-served" }),
        span("hdr-1", "model_headers", 200, { model: "model-served", parentSpanId: "req-1" }),
        span("fb-1", "model_first_byte", 300, { model: "model-served", parentSpanId: "req-1" }),
        span("body-1", "model_body", 700, { model: "model-served", parentSpanId: "req-1" }),
        // Recorded before the proxy named the model; no byte arrived.
        span("req-2", "model_request", 400),
        span("fb-2", "model_first_byte", 400, { parentSpanId: "req-2", outcome: "cancelled" }),
      ]);
    });
    expect(
      obs
        .prepare(
          "SELECT span_id, model, model_source, request_kind, duration_ms, headers_ms, first_byte_ms, body_ms FROM model_latency ORDER BY span_id",
        )
        .all(),
    ).toEqual([
      {
        span_id: "req-1",
        model: "model-served",
        model_source: "request",
        request_kind: "messages",
        duration_ms: 900,
        headers_ms: 200,
        first_byte_ms: 300,
        body_ms: 700,
      },
      {
        span_id: "req-2",
        model: "model-a",
        model_source: "run",
        request_kind: "messages",
        duration_ms: 400,
        headers_ms: null,
        first_byte_ms: null,
        body_ms: null,
      },
    ]);
  });

  it("shows pending approvals, expiries and who decided", async () => {
    const { obs } = await collected((l) => {
      const done = seedRun(l.ctx, l); // decided by human:web
      const open = seedRun(l.ctx, l, "running");
      const approval = (id: string, run: RunId, decision: string | null, by: string | null) =>
        l.ctx.db
          .prepare(
            `INSERT INTO approvals (id, workspace_id, run_id, bot_id, thread_id, kind, action_json,
               risk_level, wait_mode, decision, decided_by, decided_at, created_at)
             VALUES (?, ?, ?, ?, ?, 'tool', '{"toolName":"send_mail"}', 'L2', 'live', ?, ?, ?, ?)`,
          )
          .run(
            id,
            l.workspaceId,
            run,
            l.botId,
            l.threadId,
            decision,
            by,
            decision ? new Date(Date.now() + 1000).toISOString() : null,
            new Date().toISOString(),
          );
      approval("apr_user", done, "allow_once", "user:usr_1");
      approval("apr_expired", done, "deny", "system:expiry");
      approval("apr_closed", done, "deny", "system:run_ended");
      approval("apr_reviewer", done, "allow_once", "reviewer:model-r");
      approval("apr_mode", done, "allow_once", "mode:approve_all");
      approval("apr_pending", open, null, null);
      approval("apr_lost", done, null, null);
    });
    const rows = obs
      .prepare(
        "SELECT approval_id, state, decider_group FROM approval_requests_named WHERE approval_id NOT LIKE 'apr_obs_%' ORDER BY approval_id",
      )
      .all();
    expect(rows).toEqual([
      { approval_id: "apr_closed", state: "decided", decider_group: "closed" },
      { approval_id: "apr_expired", state: "decided", decider_group: "expired" },
      { approval_id: "apr_lost", state: "unknown", decider_group: null },
      { approval_id: "apr_mode", state: "decided", decider_group: "mode" },
      { approval_id: "apr_pending", state: "pending", decider_group: null },
      { approval_id: "apr_reviewer", state: "decided", decider_group: "reviewer" },
      { approval_id: "apr_user", state: "decided", decider_group: "human" },
    ]);
    // seedRun's own approvals were decided by `human:web`.
    expect(
      obs
        .prepare(
          "SELECT DISTINCT decider_group FROM approval_waits WHERE approval_id LIKE 'apr_obs_%'",
        )
        .all(),
    ).toEqual([{ decider_group: "human" }]);
  });
});
