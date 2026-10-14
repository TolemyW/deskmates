// Read projection over durable receipts. Never writes provisional counts into session_usage.
// Proxy and SDK observations provide lower bounds; final rows reconcile the matching prefix.
import type { ModelPrice, RunId, RunUsageReceipt, UsageCoverage } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";
import { type ModelRequestRecord, ModelRequestStore } from "./model-requests.js";
import { PriceStore } from "./prices.js";
import { priceUsage } from "./pricing.js";

const keys = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreateTokens"] as const;
export type AttemptReceipt = RunUsageReceipt & { attempt: number };
export interface UsageReceipts {
  rows: AttemptReceipt[];
  coverage: UsageCoverage;
}

interface RunRow {
  id: RunId;
  attempt: number;
  started_at: string | null;
  created_at: string;
  status: string;
}
interface ReceiptEvent {
  attempt: number;
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * Coverage of several receipts together. A measured `partial` beats `unknown`; `complete` with
 * `unknown` is `partial`; runs that never started add nothing unless nothing else is present.
 * No input has no coverage.
 */
export function combineCoverage(values: readonly UsageCoverage[]): UsageCoverage | undefined {
  const started = values.filter((c) => c !== "not_started");
  if (!started.length) return values.length ? "not_started" : undefined;
  if (started.includes("partial")) return "partial";
  if (started.includes("unknown")) return started.includes("complete") ? "partial" : "unknown";
  return "complete";
}

export function usageReceipts(db: GatewayDb, runId: RunId): UsageReceipts {
  return usageReceiptsForRuns(db, [runId]).get(runId) ?? { rows: [], coverage: "unknown" };
}

/**
 * The receipts of many runs with a fixed number of statements per 500 runs (plus one price
 * lookup per distinct model), so a cost report or an alert evaluation does not issue
 * per-run queries.
 */
export function usageReceiptsForRuns(
  db: GatewayDb,
  runIds: readonly RunId[],
): Map<RunId, UsageReceipts> {
  const ids = [...new Set(runIds)];
  const runs: RunRow[] = [];
  const finals = new Map<string, AttemptReceipt[]>();
  const events = new Map<string, ReceiptEvent[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const marks = chunk.map(() => "?").join(",");
    runs.push(
      ...(db
        .prepare(
          `SELECT id, attempt, started_at, created_at, status FROM runs WHERE id IN (${marks})`,
        )
        .all(...chunk) as RunRow[]),
    );
    for (const row of db
      .prepare(`SELECT run_id AS runId, attempt, model, input_tokens AS inputTokens,
      output_tokens AS outputTokens, cache_read_tokens AS cacheReadTokens,
      cache_create_tokens AS cacheCreateTokens, cost_usd AS costUsd FROM run_usage
      WHERE run_id IN (${marks}) ORDER BY id`)
      .all(...chunk) as AttemptReceipt[])
      push(finals, row.runId, row);
    for (const e of db
      .prepare(
        `SELECT run_id, attempt, kind, payload_json FROM run_events WHERE run_id IN (${marks}) AND (kind = 'turn_usage' OR (kind = 'log' AND source IN ('sdk', 'usage_final', 'usage_session_baseline'))) ORDER BY run_id, seq`,
      )
      .all(...chunk) as { run_id: string; attempt: number; kind: string; payload_json: string }[])
      push(events, e.run_id, {
        attempt: e.attempt,
        kind: e.kind,
        payload: JSON.parse(e.payload_json) as Record<string, unknown>,
      });
  }
  const requests = new Map<string, ModelRequestRecord[]>();
  for (const r of new ModelRequestStore(db).listForRuns(ids))
    if (r.requestKind === "messages" && !r.refusal) push(requests, r.runId, r);
  const priceStore = new PriceStore(db);
  const priceCache = new Map<string, ModelPrice[]>();
  const pricesFor = (model: string) => {
    let prices = priceCache.get(model);
    if (!prices) {
      prices = priceStore.listForModel(model);
      priceCache.set(model, prices);
    }
    return prices;
  };
  const out = new Map<RunId, UsageReceipts>();
  for (const run of runs)
    out.set(
      run.id,
      project(
        run,
        finals.get(run.id) ?? [],
        events.get(run.id) ?? [],
        requests.get(run.id) ?? [],
        pricesFor,
      ),
    );
  return out;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function project(
  run: RunRow,
  finals: AttemptReceipt[],
  events: ReceiptEvent[],
  requests: ModelRequestRecord[],
  pricesFor: (model: string) => ModelPrice[],
): UsageReceipts {
  const runId = run.id;
  const observed = new Map<string, AttemptReceipt>();
  const sessions = new Map<number, string>();
  for (const e of events)
    if (
      e.kind === "log" &&
      ["sdk", "usage_final"].includes(String(e.payload.source)) &&
      typeof e.payload.usageSessionFingerprint === "string" &&
      /^[a-f0-9]{64}$/.test(e.payload.usageSessionFingerprint)
    )
      sessions.set(e.attempt ?? 1, e.payload.usageSessionFingerprint);
  const sameSession = (a: number, b: number) =>
    sessions.has(a) && sessions.get(a) === sessions.get(b);
  function add(
    attempt: number,
    model: string,
    counts: Record<(typeof keys)[number], unknown>,
    requested?: string | null,
    served?: string | null,
  ) {
    const key = JSON.stringify([attempt, model]);
    let row = observed.get(key);
    if (!row) {
      row = {
        runId,
        attempt,
        model,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheCreateTokens: null,
        costUsd: null,
        coverage: "partial",
        servedModel: served ?? null,
        requestedModels: [],
      };
      observed.set(key, row);
    }
    if (requested && !row.requestedModels?.includes(requested))
      row.requestedModels?.push(requested);
    for (const k of keys) {
      const value = counts[k];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        row[k] = (row[k] ?? 0) + value;
    }
  }
  // Proxy observations include independent retries, even when the SDK never emits an assistant.
  for (const r of requests)
    add(
      r.attempt,
      r.servedModel ?? r.model ?? "unknown",
      r,
      r.rewrittenFrom ?? r.model,
      r.servedModel,
    );
  const proxy = new Map([...observed].map(([key, row]) => [key, { ...row }]));
  observed.clear();
  const turns = new Map<
    string,
    { attempt: number; model: string; counts: Record<(typeof keys)[number], unknown> }
  >();
  for (const e of events) {
    if (e.kind !== "turn_usage") continue;
    const p = e.payload;
    if (typeof p.model !== "string" || !Number.isInteger(p.turn)) continue;
    const identity = JSON.stringify([e.attempt, p.turn]);
    let turn = turns.get(identity);
    if (!turn) {
      turn = {
        attempt: e.attempt ?? 1,
        model: p.model,
        counts: {
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheCreateTokens: null,
        },
      };
      turns.set(identity, turn);
    }
    for (const k of keys) {
      const value = p[k];
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        turn.counts[k] = Math.max(
          typeof turn.counts[k] === "number" ? (turn.counts[k] as number) : 0,
          value,
        );
    }
  }
  for (const turn of turns.values())
    add(turn.attempt, turn.model, turn.counts, undefined, turn.model);
  // Without shared response IDs the sources cannot safely be added. Their per-model maximum
  // is a measured lower bound, preserving SDK receipts even if proxy usage was never saved.
  const sdkRows = [...observed.values()];
  for (const [key, row] of proxy) {
    if (!row.servedModel && !observed.has(key)) {
      // Subtract only SDK observations of a model this attempt's requests for the same model are
      // known to have been served as; an unrelated model's usage is not this row's.
      const served = new Set(
        requests
          .filter((r) => r.attempt === row.attempt && r.model === row.model && r.servedModel)
          .map((r) => r.servedModel),
      );
      const candidates = sdkRows.filter((s) => s.attempt === row.attempt && served.has(s.model));
      for (const k of keys)
        if (row[k] !== null && candidates.length)
          row[k] = Math.max(0, row[k] - candidates.reduce((n, s) => n + (s[k] ?? 0), 0));
    }
    const sdk = observed.get(key);
    if (sdk)
      for (const k of keys)
        if (sdk[k] !== null) row[k] = row[k] === null ? sdk[k] : Math.max(row[k], sdk[k]);
    if (sdk?.servedModel) row.servedModel = sdk.servedModel;
    observed.set(key, row);
  }
  // Consume the matching observations once per model. A smaller final can omit retry
  // usage: retain the measured excess as partial instead of throwing it away.
  const coveredKeys = new Set<string>();
  const ambiguousKeys = new Set<string>();
  for (const final of [...finals].sort((a, b) => a.attempt - b.attempt)) {
    const remaining = { ...final };
    for (const [key, row] of observed) {
      if (row.model !== final.model || row.attempt > final.attempt) continue;
      const certain = row.attempt === final.attempt || sameSession(row.attempt, final.attempt);
      const ambiguous = !certain && (!sessions.has(row.attempt) || !sessions.has(final.attempt));
      if (!certain && !ambiguous) continue;
      if (ambiguous) ambiguousKeys.add(key);
      coveredKeys.add(key);
      for (const k of keys)
        if (row[k] !== null) {
          const overlap = Math.min(row[k], remaining[k] ?? 0);
          row[k] -= overlap;
          remaining[k] = (remaining[k] ?? 0) - overlap;
        }
    }
  }
  for (const [key, row] of observed) {
    if (
      coveredKeys.has(key) &&
      !ambiguousKeys.has(key) &&
      keys.every((k) => row[k] === null || row[k] === 0)
    ) {
      observed.delete(key);
      continue;
    }
    row.coverage = keys.some((k) => row[k] !== null) ? "partial" : "unknown";
    // Price only actually observed counters; cost remains a lower bound, coverage stays partial.
    if (row.servedModel && keys.some((k) => row[k] !== null))
      row.costUsd = priceUsage(
        pricesFor(row.servedModel),
        row.servedModel,
        {
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
          cacheReadTokens: row.cacheReadTokens ?? 0,
          cacheCreateTokens: row.cacheCreateTokens ?? 0,
        },
        run.started_at ?? run.created_at,
      );
  }
  for (const row of finals) {
    if (
      events.some(
        (e) =>
          e.attempt === row.attempt &&
          e.payload.source === "usage_session_baseline" &&
          e.payload.model === row.model &&
          e.payload.attributionUncertain === true,
      )
    ) {
      row.coverage = "partial";
      row.attributionUncertain = true;
    }
    const matched = requests.filter(
      (r) =>
        (r.attempt === row.attempt ||
          (r.attempt < row.attempt && sameSession(r.attempt, row.attempt))) &&
        (r.servedModel === row.model || (!r.servedModel && r.model === row.model)),
    );
    if (matched.length) {
      row.requestedModels = [
        ...new Set(
          matched.map((r) => r.rewrittenFrom ?? r.model).filter((m): m is string => m !== null),
        ),
      ];
      row.servedModel = matched.some((r) => r.servedModel === row.model) ? row.model : null;
    }
  }
  const rows = [...finals, ...observed.values()];
  const measured = rows.some((r) => keys.some((k) => r[k] !== null));
  const unfinalized = requests.some(
    (r) =>
      !finals.some(
        (f) =>
          f.attempt === r.attempt || (f.attempt > r.attempt && sameSession(r.attempt, f.attempt)),
      ),
  );
  const coverage: UsageCoverage =
    observed.size ||
    finals.some((f) => f.attributionUncertain) ||
    unfinalized ||
    (run.started_at !== null && finals.length > 0 && !finals.some((f) => f.attempt === run.attempt))
      ? measured
        ? "partial"
        : "unknown"
      : finals.length
        ? "complete"
        : run.started_at === null
          ? // Never started (queued, cancelled or failed before start): no model call possible.
            "not_started"
          : "unknown";
  return { rows, coverage };
}

export function combineReceipts(rows: AttemptReceipt[]): RunUsageReceipt[] {
  const result = new Map<string, RunUsageReceipt>();
  const coverages = new Map<string, (UsageCoverage | undefined)[]>();
  for (const { attempt: _attempt, ...row } of rows) {
    const prior = result.get(row.model);
    coverages.set(row.model, [...(coverages.get(row.model) ?? []), row.coverage]);
    if (!prior) {
      result.set(row.model, { ...row });
      continue;
    }
    for (const key of keys) if (row[key] !== null) prior[key] = (prior[key] ?? 0) + row[key];
    if (row.costUsd !== null)
      prior.costUsd = Math.round(((prior.costUsd ?? 0) + row.costUsd) * 1e6) / 1e6;
    if (row.attributionUncertain) prior.attributionUncertain = true;
    if (row.servedModel !== undefined && prior.servedModel === undefined)
      prior.servedModel = row.servedModel;
    if (row.requestedModels)
      prior.requestedModels = [
        ...new Set([...(prior.requestedModels ?? []), ...row.requestedModels]),
      ];
  }
  // A final row carries no coverage: it is complete. Combine by precedence, never last-wins.
  for (const [model, values] of coverages) {
    const row = result.get(model);
    if (!row || values.every((c) => c === undefined)) continue;
    const combined = combineCoverage(values.map((c) => c ?? "complete"));
    if (combined) row.coverage = combined;
  }
  return [...result.values()];
}
