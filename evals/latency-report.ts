#!/usr/bin/env node
// Run startup latency from a Gateway ledger (ADR-0037 decision 6). Zero tokens:
//
//   npm run latency-report -- --db data/gateway.sqlite [--since <ISO time>] [--jobs] [--json]
//                             [--report <file.md>]
//
// p50 and p95 of time to first model request, first token, first text, first visible text and
// attempt end, per class of attempt (fresh or resumed start, new or resumed SDK session, cold or
// warm sandbox, retried or not), with failure, retry and first-turn cache distributions. The file
// is opened read-only; a production ledger is never changed. Definitions: `latency/metrics.ts`.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadLatencyRuns } from "./latency/load.js";
import { renderLatencyMarkdown, summarizeLatency } from "./latency/metrics.js";

interface ParsedArgs {
  db?: string;
  since?: string;
  report?: string;
  json: boolean;
  jobs: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { json: false, jobs: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json") out.json = true;
    else if (arg === "--jobs") out.jobs = true;
    else if (arg === "--db" || arg === "--report" || arg === "--since") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--db") out.db = value;
      else if (arg === "--report") out.report = value;
      else out.since = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.db) {
    process.stderr.write(
      "usage: latency-report --db <gateway.sqlite> [--since <ISO>] [--jobs] [--json] [--report <file.md>]\n",
    );
    return 2;
  }
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const summary = summarizeLatency(loadLatencyRuns(db, args.since), { includeJobs: args.jobs });
    const markdown = renderLatencyMarkdown(summary, args.db);
    if (args.report) await writeFile(args.report, markdown, "utf8");
    process.stdout.write(args.json ? `${JSON.stringify(summary, null, 2)}\n` : markdown);
    return 0;
  } finally {
    db.close();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
