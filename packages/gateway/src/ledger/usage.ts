// Per-(run, model) token counts, priced by the Gateway at record time (ADR-0002 item 5).
//
// The SDK's `modelUsage` is cumulative over a session, and a resumed session continues from the
// totals its transcript saved: the first result of a resumed run already carries every earlier
// run's tokens. Each thread run resumes the bot's session for that thread (ADR-0005), so a run's
// own usage is the difference from what the previous run in that session reported. The last
// reported totals live in `session_usage`, keyed by (bot, thread, model) with the session id they
// belong to; a run whose session id differs from the stored one starts the totals over.

import { createHash } from "node:crypto";
import type { BotId, RunId, RunUsage, ThreadId } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { EventStore } from "./events.js";
import type { PriceStore } from "./prices.js";
import { priceUsage } from "./pricing.js";
import { usageReceiptsForRuns } from "./usage-receipts.js";

interface UsageRow {
  run_id: string;
  model: string;
  attempt: number;
  source: UsageSource;
  usage_complete: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
  cost_usd: number | null;
}

interface SessionUsageRow {
  sdk_session_id: string;
  updated_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_create_tokens: number;
}

export type UsageCounts = Omit<RunUsage, "runId" | "costUsd">;

/**
 * Where an attempt's `run_usage` rows came from (ADR-0029 decision 8): `sdk`, the sidecar's final
 * report; `proxy`, the `model_requests` the attempt's token made, because the sidecar never
 * reported (a restart, the deadline, a crash, a forced stop) or reported a total the Gateway
 * cannot use as a baseline.
 */
export type UsageSource = "sdk" | "proxy";

interface ProxyRequestRow {
  model: string | null;
  served_model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_create_tokens: number | null;
}

/** The session a run's usage report belongs to, when the run has a thread. */
export interface UsageSession {
  botId: BotId;
  threadId: ThreadId;
  /** Session id the sidecar reported at the end of the run; absent when the SDK never started. */
  sdkSessionId: string | undefined;
}

const COUNT_KEYS = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreateTokens"] as const;

export class UsageStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly prices: PriceStore,
    private readonly events: EventStore,
  ) {}

  /**
   * Stores usage rows for one attempt of a run, pricing each at `pricedAt` (the run's start). An
   * unpriced model gets `cost_usd` NULL and a `pricing_missing` event naming it; the run still
   * succeeds. With a `session`, each reported total is turned into the delta since the previous
   * run of the same session, so a resumed session is not billed twice.
   *
   * `attempt` is the run row's current attempt. Rows are keyed on `(run, attempt, model)`: a
   * resumed process reports the session's totals again, its delta is that attempt's share, and
   * overwriting the previous attempt's row would throw away everything before the park.
   */
  record(
    runId: RunId,
    attempt: number,
    usage: readonly UsageCounts[],
    pricedAt: string,
    session?: UsageSession,
    sdkSessionId?: string,
  ): RunUsage[] {
    // ADR-0029 decision 8: after an attempt whose usage came from the proxy, the SDK's cumulative
    // total has no usable baseline. The session's totals still move to the report, so the run
    // after this one is measured from it, but this attempt's rows come from its requests.
    if (this.followsProxySourced(runId, attempt, session))
      return this.db.transaction(() => {
        this.recordSdk(runId, attempt, usage, pricedAt, session, sdkSessionId, false);
        return this.recordFromProxy(runId, attempt, pricedAt);
      })();
    return this.recordSdk(runId, attempt, usage, pricedAt, session, sdkSessionId, true);
  }

  /**
   * ADR-0029 decision 8: the attempt's rows from the `model_requests` its token made, one per
   * served model, marked `proxy`. A request whose usage the upstream never reported makes the
   * row incomplete (`usage_complete = 0`): a lower bound, unknown beyond it, never zero. Replaces
   * whatever the attempt had, so a later call (a late response) corrects it rather than adds.
   */
  recordFromProxy(runId: RunId, attempt: number, pricedAt: string): RunUsage[] {
    return this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT model, served_model, input_tokens, output_tokens, cache_read_tokens,
                  cache_create_tokens
             FROM model_requests
            WHERE run_id = ? AND attempt = ? AND request_kind = 'messages' AND refusal IS NULL
            ORDER BY seq`,
        )
        .all(runId, attempt) as ProxyRequestRow[];
      // No request reached the upstream: nothing was spent, and nothing replaces what is there.
      if (rows.length === 0) return [];
      const byModel = new Map<string, { counts: UsageCounts; complete: boolean }>();
      for (const r of rows) {
        const model = r.served_model ?? r.model ?? "unknown";
        let entry = byModel.get(model);
        if (!entry) {
          entry = {
            counts: {
              model,
              inputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheCreateTokens: 0,
            },
            complete: true,
          };
          byModel.set(model, entry);
        }
        if (r.input_tokens === null || r.output_tokens === null) entry.complete = false;
        entry.counts.inputTokens += r.input_tokens ?? 0;
        entry.counts.outputTokens += r.output_tokens ?? 0;
        entry.counts.cacheReadTokens += r.cache_read_tokens ?? 0;
        entry.counts.cacheCreateTokens += r.cache_create_tokens ?? 0;
      }
      this.db.prepare("DELETE FROM run_usage WHERE run_id = ? AND attempt = ?").run(runId, attempt);
      const out: RunUsage[] = [];
      for (const { counts, complete } of byModel.values()) {
        const cost = priceUsage(
          this.prices.listForModel(counts.model),
          counts.model,
          counts,
          pricedAt,
        );
        this.db
          .prepare(
            `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, source, usage_complete)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proxy', ?)`,
          )
          .run(
            runId,
            attempt,
            counts.model,
            counts.inputTokens,
            counts.outputTokens,
            counts.cacheReadTokens,
            counts.cacheCreateTokens,
            cost,
            complete ? 1 : 0,
          );
        if (cost === null)
          this.events.append({ runId, kind: "pricing_missing", payload: { model: counts.model } });
        out.push({ runId, ...counts, costUsd: cost });
      }
      this.events.append({
        runId,
        attempt,
        kind: "log",
        payload: {
          source: "usage_proxy",
          requests: rows.length,
          models: [...byModel.keys()],
          complete: [...byModel.values()].every((e) => e.complete),
        },
      });
      return out;
    })();
  }

  /** Whether the attempt has any `run_usage` row yet, from either source. */
  hasAttemptUsage(runId: RunId, attempt: number): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM run_usage WHERE run_id = ? AND attempt = ? LIMIT 1")
        .get(runId, attempt) !== undefined
    );
  }

  /**
   * Whether this attempt's SDK total sits on top of an attempt that was proxy-sourced since the
   * session's totals were last stored: an earlier attempt of the same run, or another run of the
   * same (bot, thread) session that started after the stored totals.
   */
  private followsProxySourced(runId: RunId, attempt: number, session?: UsageSession): boolean {
    const own = this.db
      .prepare(
        "SELECT 1 FROM run_usage WHERE run_id = ? AND attempt < ? AND source = 'proxy' LIMIT 1",
      )
      .get(runId, attempt);
    if (own !== undefined) return true;
    if (!session) return false;
    const stored = this.db
      .prepare("SELECT max(updated_at) AS at FROM session_usage WHERE bot_id = ? AND thread_id = ?")
      .get(session.botId, session.threadId) as { at: string | null };
    return (
      this.db
        .prepare(
          `SELECT 1 FROM run_usage u JOIN runs r ON r.id = u.run_id
            WHERE r.bot_id = ? AND r.thread_id = ? AND r.id != ? AND u.source = 'proxy'
              AND coalesce(r.started_at, r.created_at) >= ? LIMIT 1`,
        )
        .get(session.botId, session.threadId, runId, stored.at ?? "") !== undefined
    );
  }

  private recordSdk(
    runId: RunId,
    attempt: number,
    usage: readonly UsageCounts[],
    pricedAt: string,
    session: UsageSession | undefined,
    sdkSessionId: string | undefined,
    write: boolean,
  ): RunUsage[] {
    return this.db.transaction(() => {
      const out: RunUsage[] = [];
      const sessionId = sdkSessionId ?? session?.sdkSessionId;
      // Hash once per receipt, not once per reported model.
      const fingerprint = sessionId ? fingerprintOf(sessionId) : undefined;
      const sessionFingerprint = session?.sdkSessionId
        ? session.sdkSessionId === sessionId
          ? fingerprint
          : fingerprintOf(session.sdkSessionId)
        : undefined;
      if (fingerprint && usage.length)
        this.events.append({
          runId,
          attempt,
          kind: "log",
          payload: {
            source: "usage_final",
            usageSessionFingerprint: fingerprint,
          },
        });
      for (const reported of usage) {
        const u = session
          ? this.deltaForSession(runId, attempt, session, reported, sessionFingerprint)
          : attempt > 1 && this.isThreadlessTrigger(runId)
            ? this.deltaForRunAttempt(runId, attempt, reported, fingerprint)
            : reported;
        if (!write) continue;
        const cost = priceUsage(this.prices.listForModel(u.model), u.model, u, pricedAt);
        // An SDK final replaces a proxy row of the same attempt (a `run_ended` recovered from
        // stdout after the Gateway had filled the attempt in from its requests).
        this.db
          .prepare(
            `INSERT INTO run_usage (run_id, attempt, model, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, cost_usd, source, usage_complete)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sdk', 1)
             ON CONFLICT (run_id, attempt, model) DO UPDATE SET
               input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
               cache_read_tokens = excluded.cache_read_tokens, cache_create_tokens = excluded.cache_create_tokens,
               cost_usd = excluded.cost_usd, source = 'sdk', usage_complete = 1`,
          )
          .run(
            runId,
            attempt,
            u.model,
            u.inputTokens,
            u.outputTokens,
            u.cacheReadTokens,
            u.cacheCreateTokens,
            cost,
          );
        if (cost === null) {
          this.events.append({ runId, kind: "pricing_missing", payload: { model: u.model } });
        }
        out.push({ runId, ...u, costUsd: cost });
      }
      return out;
    })();
  }

  /** Cron/webhook continuation resumes the same SDK session without a thread session row. */
  private isThreadlessTrigger(runId: RunId): boolean {
    const run = this.db
      .prepare("SELECT thread_id, trigger_kind FROM runs WHERE id = ?")
      .get(runId) as { thread_id: string | null; trigger_kind: string };
    return (
      run.thread_id === null &&
      (run.trigger_kind === "cron" ||
        run.trigger_kind === "manual" ||
        run.trigger_kind === "model_job" ||
        run.trigger_kind === "webhook")
    );
  }

  /** Cron/webhook continuation resumes the same SDK session without a thread session row. */
  private deltaForRunAttempt(
    runId: RunId,
    attempt: number,
    reported: UsageCounts,
    fingerprint?: string,
  ): UsageCounts {
    const prior = this.db
      .prepare(
        `SELECT coalesce(sum(input_tokens), 0) AS inputTokens,
              coalesce(sum(output_tokens), 0) AS outputTokens,
              coalesce(sum(cache_read_tokens), 0) AS cacheReadTokens,
              coalesce(sum(cache_create_tokens), 0) AS cacheCreateTokens
       FROM run_usage WHERE run_id = ? AND model = ? AND attempt < ?`,
      )
      .get(runId, reported.model, attempt) as Record<(typeof COUNT_KEYS)[number], number>;
    if (fingerprint) {
      // Only this run's earlier final-receipt identities, not its whole event log.
      const sessions = new Map<number, string>();
      for (const e of this.db
        .prepare(
          `SELECT attempt, json_extract(payload_json, '$.usageSessionFingerprint') AS fingerprint
             FROM run_events WHERE run_id = ? AND kind = 'log' AND attempt < ?
              AND source = 'usage_final' ORDER BY seq`,
        )
        .all(runId, attempt) as { attempt: number; fingerprint: unknown }[])
        if (typeof e.fingerprint === "string") sessions.set(e.attempt ?? 1, e.fingerprint);
      const earlier = this.listByAttempt(runId).filter(
        (r) => r.attempt < attempt && r.model === reported.model,
      );
      // Only narrow a legacy baseline when every prior row has an observed session identity.
      if (earlier.every((r) => sessions.has(r.attempt)))
        for (const key of COUNT_KEYS)
          prior[key] = earlier
            .filter((r) => sessions.get(r.attempt) === fingerprint)
            .reduce((n, r) => n + r[key], 0);
    }
    const delta: UsageCounts = { ...reported };
    for (const key of COUNT_KEYS)
      delta[key] = reported[key] >= prior[key] ? reported[key] - prior[key] : reported[key];
    return delta;
  }

  /**
   * The run's share of a cumulative report: reported minus the totals stored for the same session.
   * A different (or missing) session id, or a count below the stored one, means the SDK started
   * counting afresh, so the report is taken whole. The stored totals become the report.
   */
  private deltaForSession(
    runId: RunId,
    attempt: number,
    session: UsageSession,
    reported: UsageCounts,
    fingerprint?: string,
  ): UsageCounts {
    const prev = this.db
      .prepare(
        "SELECT sdk_session_id, updated_at, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens FROM session_usage WHERE bot_id = ? AND thread_id = ? AND model = ?",
      )
      .get(session.botId, session.threadId, reported.model) as SessionUsageRow | undefined;
    const continued =
      prev !== undefined &&
      session.sdkSessionId !== undefined &&
      prev.sdk_session_id === session.sdkSessionId;
    const previous: UsageCounts = continued
      ? {
          model: reported.model,
          inputTokens: prev.input_tokens,
          outputTokens: prev.output_tokens,
          cacheReadTokens: prev.cache_read_tokens,
          cacheCreateTokens: prev.cache_create_tokens,
        }
      : {
          model: reported.model,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheCreateTokens: 0,
        };
    let resetFloor: UsageCounts = { ...previous };
    // Freeze the baseline for this final receipt. Redelivering/correcting that receipt must
    // not subtract the just-recorded session total from itself. Historical finals without a
    // baseline can recover it from their own recorded delta.
    const baselineRow = this.db
      .prepare(
        `SELECT payload_json FROM run_events
          WHERE run_id = ? AND attempt = ? AND kind = 'log'
            AND source = 'usage_session_baseline'
            AND json_extract(payload_json, '$.model') = ?
            AND json_extract(payload_json, '$.usageSessionFingerprint') IS ?
          ORDER BY seq LIMIT 1`,
      )
      .get(runId, attempt, reported.model, fingerprint ?? null) as
      | { payload_json: string }
      | undefined;
    const baseline = baselineRow
      ? (JSON.parse(baselineRow.payload_json) as Record<string, unknown>)
      : undefined;
    if (baseline) {
      for (const k of COUNT_KEYS) previous[k] = baseline[k] as number;
      resetFloor = (baseline.resetFloor as UsageCounts | undefined) ?? { ...previous };
    } else {
      let attributionUncertain = false;
      const own = this.listByAttempt(runId).find(
        (u) => u.attempt === attempt && u.model === reported.model,
      );
      if (continued && own)
        for (const k of COUNT_KEYS) previous[k] = Math.max(0, previous[k] - own[k]);
      resetFloor = { ...previous };
      if (session.sdkSessionId && !own) {
        // Runs interrupted since the last final remain measured receipts, not session totals.
        // Allocate their known lower bounds before attributing the later cumulative delta.
        // Only an exact, gateway-recorded resumed session is eligible; never guess a session.
        const interrupted = this.db
          .prepare(`SELECT id FROM runs WHERE bot_id = ? AND thread_id = ?
          AND id != ? AND started_at >= ? AND
          coalesce((SELECT json_extract(e.payload_json, '$.usageSessionFingerprint') FROM run_events e
            WHERE e.run_id = runs.id AND e.kind = 'log' AND e.source = 'sdk'
            ORDER BY e.seq DESC LIMIT 1), json_extract(config_json, '$.usageSessionFingerprint')) = ?`)
          .all(
            session.botId,
            session.threadId,
            runId,
            continued ? prev.updated_at : "",
            fingerprint,
          ) as { id: RunId }[];
        const receipts = usageReceiptsForRuns(
          this.db,
          interrupted.map((r) => r.id),
        );
        for (const receipt of receipts.values()) {
          if (receipt.coverage === "partial" || receipt.coverage === "unknown")
            attributionUncertain = true;
          for (const row of receipt.rows) {
            if (row.coverage !== "partial" || row.model !== reported.model) continue;
            for (const k of COUNT_KEYS) previous[k] += row[k] ?? 0;
          }
        }
      }
      this.events.append({
        runId,
        attempt,
        kind: "log",
        payload: {
          source: "usage_session_baseline",
          usageSessionFingerprint: fingerprint ?? null,
          ...previous,
          resetFloor,
          attributionUncertain,
        },
      });
    }
    const delta: UsageCounts = { ...reported };
    for (const k of COUNT_KEYS) {
      delta[k] = reported[k] < resetFloor[k] ? reported[k] : Math.max(0, reported[k] - previous[k]);
    }
    this.db
      .prepare(
        `INSERT INTO session_usage (bot_id, thread_id, model, sdk_session_id, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (bot_id, thread_id, model) DO UPDATE SET
           sdk_session_id = excluded.sdk_session_id,
           input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens,
           cache_read_tokens = excluded.cache_read_tokens, cache_create_tokens = excluded.cache_create_tokens,
           updated_at = excluded.updated_at`,
      )
      .run(
        session.botId,
        session.threadId,
        reported.model,
        session.sdkSessionId ?? "",
        reported.inputTokens,
        reported.outputTokens,
        reported.cacheReadTokens,
        reported.cacheCreateTokens,
        nowIso(),
      );
    return delta;
  }

  /**
   * What the run spent, one entry per model, summed over every attempt. A parked run that was
   * resumed has a row per attempt; the caller asked what the run cost, not what its last process
   * did. `costUsd` is the sum of the attempts that had a price and stays null only when none of
   * them did: a run half of whose attempts ran on an unpriced model reports the half it can
   * price, which is nearer the truth than null and nearer than zero.
   */
  list(runId: RunId): RunUsage[] {
    const rows = this.db
      .prepare("SELECT * FROM run_usage WHERE run_id = ? ORDER BY id")
      .all(runId) as UsageRow[];
    const byModel = new Map<string, RunUsage>();
    for (const r of rows) {
      const total = byModel.get(r.model);
      if (!total) {
        byModel.set(r.model, {
          runId: r.run_id as RunId,
          model: r.model,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheCreateTokens: r.cache_create_tokens,
          costUsd: r.cost_usd,
        });
        continue;
      }
      total.inputTokens += r.input_tokens;
      total.outputTokens += r.output_tokens;
      total.cacheReadTokens += r.cache_read_tokens;
      total.cacheCreateTokens += r.cache_create_tokens;
      if (r.cost_usd !== null) {
        // Micro-dollar rounding, as in `priceUsage`, so a sum does not drift on float noise.
        total.costUsd = Math.round(((total.costUsd ?? 0) + r.cost_usd) * 1e6) / 1e6;
      }
    }
    return [...byModel.values()];
  }

  /** Every stored row for a run, attempt by attempt. The ledger view and its tests read it. */
  listByAttempt(
    runId: RunId,
  ): (RunUsage & { attempt: number; source: UsageSource; usageComplete: boolean })[] {
    const rows = this.db
      .prepare("SELECT * FROM run_usage WHERE run_id = ? ORDER BY id")
      .all(runId) as UsageRow[];
    return rows.map((r) => ({
      runId: r.run_id as RunId,
      model: r.model,
      attempt: r.attempt,
      source: r.source,
      usageComplete: r.usage_complete === 1,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreateTokens: r.cache_create_tokens,
      costUsd: r.cost_usd,
    }));
  }
}

function fingerprintOf(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}
