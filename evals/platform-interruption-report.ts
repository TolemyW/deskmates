#!/usr/bin/env node
// ADR-0029 decision 13: what a long-horizon campaign that crossed an upgrade or a restart did with
// its runs, from the Gateway ledger alone. Zero tokens:
//
//   npm run platform-interruption-report -- --db data/gateway.sqlite [--since <ISO time>] [--json]
//
// The five measures:
//   1. runs killed by a platform interruption: a Gateway start found them live and killed their
//      sidecar (target 0 for a drained upgrade); and runs that ended `gateway_restarted`;
//   2. runs continued after an interruption, and the share of them that later succeeded;
//   3. duplicate L2 effects: one approval that let more than one call run to a result (target 0);
//   4. time from a drain's start to each run's safe point (p50, max);
//   5. upgrade attempts per release: drains started, per release, and how many were ended unforced.
// The file is opened read-only; a production ledger is never changed.

import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

type Db = InstanceType<typeof Database>;

export interface PlatformInterruptionReport {
  since: string | null;
  killed: { byRestart: number; failedGatewayRestarted: number };
  continued: { runs: number; succeeded: number; successShare: number | null };
  duplicateL2Effects: { count: number; approvalIds: string[] };
  drainToSafePointMs: { parks: number; p50: number | null; max: number | null };
  upgradeAttempts: { release: string; drains: number; endedUnforced: number }[];
}

interface PlatformEvent {
  run_id: string;
  ts: string;
  op: string | null;
  reason: string | null;
}

/** Nearest-rank percentile of a non-empty sorted list. */
function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function platformInterruptionReport(db: Db, since?: string): PlatformInterruptionReport {
  const from = since ?? "";
  const events = db
    .prepare(
      `SELECT e.run_id, e.ts, json_extract(e.payload_json, '$.op') AS op,
              json_extract(e.payload_json, '$.reason') AS reason
         FROM run_events e
        WHERE e.kind = 'log' AND json_extract(e.payload_json, '$.source') = 'platform'
          AND e.ts >= ?
        ORDER BY e.ts, e.seq`,
    )
    .all(from) as PlatformEvent[];
  const byOp = (op: string) => events.filter((e) => e.op === op);

  const byRestart = new Set(byOp("restart_found_live").map((e) => e.run_id)).size;
  const failed = (
    db
      .prepare(
        "SELECT count(*) AS n FROM runs WHERE error = 'gateway_restarted' AND created_at >= ?",
      )
      .get(from) as { n: number }
  ).n;

  const continuedIds = [...new Set(byOp("resumed").map((e) => e.run_id))];
  const statusOf = db.prepare("SELECT status FROM runs WHERE id = ?");
  const succeeded = continuedIds.filter((id) => {
    const row = statusOf.get(id) as { status: string } | undefined;
    return row?.status === "succeeded" || row?.status === "silent";
  }).length;

  // An approval lets a call run; its replay or its retry may take it once (ADR-0002 amendment 2).
  // More than one successful tool result under one allowing approval is a duplicate effect.
  const allowed = db
    .prepare(
      `SELECT id, run_id, tool_use_id FROM approvals
        WHERE decision IN ('allow_once', 'allow_always') AND created_at >= ?`,
    )
    .all(from) as { id: string; run_id: string; tool_use_id: string | null }[];
  const consumers = db.prepare(
    `SELECT json_extract(payload_json, '$.toolUseId') AS tool_use_id FROM run_events
      WHERE run_id = ? AND kind = 'approval' AND json_extract(payload_json, '$.phase') = 'resumed'
        AND json_extract(payload_json, '$.approvalId') = ?`,
  );
  const results = db.prepare(
    `SELECT count(*) AS n FROM run_events
      WHERE run_id = ? AND kind = 'tool_result'
        AND json_extract(payload_json, '$.toolUseId') = ?
        AND coalesce(json_extract(payload_json, '$.isError'), 0) = 0`,
  );
  const duplicates: string[] = [];
  for (const approval of allowed) {
    const ids = new Set<string>();
    if (approval.tool_use_id) ids.add(approval.tool_use_id);
    for (const c of consumers.all(approval.run_id, approval.id) as { tool_use_id: unknown }[])
      if (typeof c.tool_use_id === "string") ids.add(c.tool_use_id);
    let executed = 0;
    for (const id of ids) executed += (results.get(approval.run_id, id) as { n: number }).n;
    if (executed > 1) duplicates.push(approval.id);
  }

  // Each drain park, measured from the latest drain that had started by then.
  const drains = db
    .prepare(
      "SELECT started_at, ended_at, release FROM gateway_drains WHERE started_at >= ? ORDER BY started_at",
    )
    .all(from) as { started_at: string; ended_at: string | null; release: string | null }[];
  const waits: number[] = [];
  for (const park of byOp("parked").filter((e) => e.reason === "drain")) {
    const drain = [...drains].reverse().find((d) => d.started_at <= park.ts);
    if (drain) waits.push(Date.parse(park.ts) - Date.parse(drain.started_at));
  }
  waits.sort((a, b) => a - b);

  const perRelease = new Map<string, { drains: number; endedUnforced: number }>();
  for (const d of drains) {
    const key = d.release ?? "(unknown)";
    const entry = perRelease.get(key) ?? { drains: 0, endedUnforced: 0 };
    entry.drains += 1;
    if (d.ended_at !== null) entry.endedUnforced += 1;
    perRelease.set(key, entry);
  }

  return {
    since: since ?? null,
    killed: { byRestart, failedGatewayRestarted: failed },
    continued: {
      runs: continuedIds.length,
      succeeded,
      successShare: continuedIds.length > 0 ? succeeded / continuedIds.length : null,
    },
    duplicateL2Effects: { count: duplicates.length, approvalIds: duplicates },
    drainToSafePointMs: {
      parks: waits.length,
      p50: percentile(waits, 50),
      max: waits.at(-1) ?? null,
    },
    upgradeAttempts: [...perRelease.entries()].map(([release, v]) => ({ release, ...v })),
  };
}

export function renderPlatformInterruptionMarkdown(r: PlatformInterruptionReport): string {
  const ms = (v: number | null) => (v === null ? "n/a" : `${(v / 1000).toFixed(1)} s`);
  return [
    "# Platform interruptions (ADR-0029 decision 13)",
    "",
    r.since ? `Since ${r.since}.` : "Whole ledger.",
    "",
    `- Runs killed by a restart: ${r.killed.byRestart}; ended gateway_restarted: ${r.killed.failedGatewayRestarted}`,
    `- Runs continued after an interruption: ${r.continued.runs}; later succeeded: ${r.continued.succeeded}${r.continued.successShare === null ? "" : ` (${(r.continued.successShare * 100).toFixed(0)}%)`}`,
    `- Duplicate L2 effects: ${r.duplicateL2Effects.count}${r.duplicateL2Effects.count > 0 ? ` (${r.duplicateL2Effects.approvalIds.join(", ")})` : ""}`,
    `- Drain to safe point: ${r.drainToSafePointMs.parks} park(s), p50 ${ms(r.drainToSafePointMs.p50)}, max ${ms(r.drainToSafePointMs.max)}`,
    "- Upgrade attempts per release:",
    ...(r.upgradeAttempts.length === 0
      ? ["  - none"]
      : r.upgradeAttempts.map(
          (a) => `  - ${a.release}: ${a.drains} drain(s), ${a.endedUnforced} ended unforced`,
        )),
    "",
  ].join("\n");
}

export function parseArgs(argv: readonly string[]): { db?: string; since?: string; json: boolean } {
  const out: { db?: string; since?: string; json: boolean } = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json") out.json = true;
    else if (arg === "--db" || arg === "--since") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--db") out.db = value;
      else out.since = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

export function main(argv: readonly string[]): number {
  const args = parseArgs(argv);
  if (!args.db) {
    process.stderr.write(
      "usage: platform-interruption-report --db <gateway.sqlite> [--since <ISO>] [--json]\n",
    );
    return 2;
  }
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const report = platformInterruptionReport(db, args.since);
    process.stdout.write(
      args.json
        ? `${JSON.stringify(report, null, 2)}\n`
        : renderPlatformInterruptionMarkdown(report),
    );
    return 0;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
