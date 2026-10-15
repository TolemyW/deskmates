#!/usr/bin/env node
// Trajectory replay (measurement §5.1, item 2). Two commands, zero tokens:
//
//   npm run replay -- export --gateway http://localhost:8080 [--since <iso>] [--run <id>]... \
//                    [--out evals/traces]    (bearer, if required: DESKMATES_OPERATOR_TOKEN)
//   npm run replay -- replay evals/traces/<runId>.json... [--report evals/results/<date>-replay.md]
//
// `export` reads the ledger through the operator API and writes one self-contained trace per run.
// `replay` plays each trace back through the current sidecar code with the fake SDK and diffs
// every decision point against what the ledger recorded. Exit code 1 on any mismatch, so it can
// be a required check on every PR.
//
// A mismatch is not automatically a bug: it is either an intended behaviour change, which then
// has to go through the strategy protocol (measurement §5.2), or a regression. What it must
// never be is a surprise.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportTraces, writeTraces } from "./replay/export.js";
import { type TraceReplayResult, replayTrace } from "./replay/replay-run.js";
import { renderReport } from "./replay/report.js";
import { parseTrace } from "./replay/trace.js";

const DEFAULT_OUT_DIR = "evals/traces";

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Map<string, string[]>;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = "", ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    let value: string;
    if (eq === -1) {
      value = rest[i + 1] ?? "";
      i += 1;
    } else {
      value = arg.slice(eq + 1);
    }
    const existing = options.get(name);
    if (existing === undefined) options.set(name, [value]);
    else existing.push(value);
  }
  return { command, positional, options };
}

function one(options: Map<string, string[]>, name: string): string | undefined {
  return options.get(name)?.[0];
}

function usage(): string {
  return [
    "usage:",
    "  replay.ts export --gateway <url> [--since <iso>] [--run <id>]... [--out <dir>]",
    "  replay.ts replay <trace.json>... [--report <path>]",
  ].join("\n");
}

async function runExport(args: ParsedArgs, log: (line: string) => void): Promise<number> {
  const gateway = one(args.options, "gateway");
  if (gateway === undefined || gateway === "") {
    log("export needs --gateway <url>");
    return 2;
  }
  const since = one(args.options, "since");
  const runIds = args.options.get("run");
  const outDir = one(args.options, "out") ?? DEFAULT_OUT_DIR;
  // ADR-0006: an authenticated Gateway needs a bearer; from the environment, never argv.
  const token = process.env.DESKMATES_OPERATOR_TOKEN?.trim();
  const traces = await exportTraces({
    gateway,
    ...(token ? { token } : {}),
    ...(since === undefined ? {} : { since }),
    ...(runIds === undefined ? {} : { runIds }),
  });
  const files = await writeTraces(traces, outDir);
  for (const file of files) log(`wrote ${file}`);
  log(`${files.length} trace(s) exported to ${outDir}`);
  return 0;
}

async function runReplay(args: ParsedArgs, log: (line: string) => void): Promise<number> {
  if (args.positional.length === 0) {
    log("replay needs at least one trace file");
    return 2;
  }
  const results: TraceReplayResult[] = [];
  for (const file of args.positional) {
    const trace = parseTrace(await readFile(file, "utf8"));
    const result = await replayTrace(trace, file);
    results.push(result);
    if (result.identical) {
      log(`${result.runId}: identical (${result.recorded.length} decision points)`);
    } else if (result.unsupported !== undefined) {
      log(`${result.runId}: unsupported: ${result.unsupported}`);
    } else if (result.error !== undefined) {
      log(`${result.runId}: replay failed: ${result.error}`);
    } else {
      log(`${result.runId}: ${result.mismatches.length} mismatch(es)`);
      for (const m of result.mismatches) {
        log(`  seq ${m.seq} ${m.tool} ${m.field}: recorded ${m.recorded}, replayed ${m.replayed}`);
      }
    }
  }
  const report = one(args.options, "report");
  if (report !== undefined && report !== "") {
    await writeFile(
      report,
      renderReport(results, { generatedAt: new Date().toISOString() }),
      "utf8",
    );
    log(`report written to ${report}`);
  }
  // An unsupported trace is not a mismatch: the replay could not put the recorded run back the
  // way it happened, and says so. Failing the check on it would make every resumed run a red PR.
  return results.every((r) => r.identical || r.unsupported !== undefined) ? 0 : 1;
}

export async function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const args = parseArgs(argv);
  if (args.command === "export") return runExport(args, log);
  if (args.command === "replay") return runReplay(args, log);
  log(usage());
  return 2;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
}

if (isMain()) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`${String(err)}\n`);
      process.exit(2);
    },
  );
}
