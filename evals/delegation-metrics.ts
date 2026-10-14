#!/usr/bin/env node
// Delegation metrics from a Gateway ledger (ADR-0016 amendment 1, decision 10). Zero tokens:
//
//   npm run delegation-metrics -- --db data/gateway.sqlite [--json] [--report <file.md>]
//
// One row per delegation chain (a bot's message that woke another bot, the run it started, what
// reached the thread when it ended, and the delegator's follow-up run) and the six numbers the
// amendment is judged on: chains completed, missed replies, stuck delegators, duplicate runs,
// wall time and tokens. A second section (ADR-0005 amendment 2) says what an unaddressed request
// costs a group: runs per request, the silent share, requests nobody took, time to first reply.
// The file is opened read-only; a production ledger is never changed.
// Definitions are at the top of `delegation/metrics.ts`.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { loadLedger } from "./delegation/load.js";
import { collectChains, renderMarkdown, summarize } from "./delegation/metrics.js";
import { collectOffers, renderOffersMarkdown, summarizeOffers } from "./delegation/offers.js";

interface ParsedArgs {
  db?: string;
  json: boolean;
  report?: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const out: ParsedArgs = { json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (arg === "--json") out.json = true;
    else if (arg === "--db" || arg === "--report") {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === "--db") out.db = value;
      else out.report = value;
    } else throw new Error(`unknown argument ${arg}`);
  }
  return out;
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (!args.db) {
    process.stderr.write(
      "usage: delegation-metrics --db <gateway.sqlite> [--json] [--report <file.md>]\n",
    );
    return 2;
  }
  const db = new Database(args.db, { readonly: true, fileMustExist: true });
  try {
    const ledger = loadLedger(db);
    const chains = collectChains(ledger);
    const summary = summarize(chains);
    const requests = collectOffers(ledger);
    const offers = summarizeOffers(ledger, requests);
    const markdown = [
      renderMarkdown(summary, chains, args.db),
      renderOffersMarkdown(offers, requests),
    ].join("\n");
    if (args.report) await writeFile(args.report, markdown, "utf8");
    process.stdout.write(
      args.json ? `${JSON.stringify({ summary, chains, offers, requests }, null, 2)}\n` : markdown,
    );
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
