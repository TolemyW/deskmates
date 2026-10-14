#!/usr/bin/env node
// Paired comparison of two eval result files (measurement §4.3, evals/README.md).
//
//   npm run compare -- <baseline.jsonl> <candidate.jsonl> [--delta 0.10] [--cost-delta 0.15]
//                      [--report evals/results/<date>-compare.md] [--json]
//
// Prints the minimum detectable effect first, then the pass-rate difference overall and per
// duration bucket with its 95% interval and verdict, the fingerprint test, the cost interval and
// the long smoke tasks. Exit code 0 when the change passes (neither the total nor any bucket is
// worse), 1 when it does not, 2 on a usage error.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_COST_DELTA,
  DEFAULT_PASS_DELTA,
  compareResults,
} from "./compare/compare-results.js";
import { renderCompareReport } from "./compare/report.js";
import { parseResultFile } from "./compare/result-row.js";

function usage(): string {
  return "usage: npm run compare -- <baseline.jsonl> <candidate.jsonl> [--delta 0.10] [--cost-delta 0.15] [--include-long] [--report <file.md>] [--json]";
}

export async function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): Promise<number> {
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    if (arg === "--json" || arg === "--include-long") options.set(arg.slice(2), "true");
    else if (eq !== -1) options.set(arg.slice(2, eq), arg.slice(eq + 1));
    else {
      options.set(arg.slice(2), argv[i + 1] ?? "");
      i += 1;
    }
  }
  const [baselinePath, candidatePath] = positional;
  const delta = Number(options.get("delta") ?? DEFAULT_PASS_DELTA);
  const costDelta = Number(options.get("cost-delta") ?? DEFAULT_COST_DELTA);
  if (
    baselinePath === undefined ||
    candidatePath === undefined ||
    positional.length !== 2 ||
    !(delta > 0 && delta < 1) ||
    !(costDelta > 0) ||
    (options.has("include-long") && options.get("include-long") !== "true")
  ) {
    log(usage());
    return 2;
  }
  const baseline = parseResultFile(await readFile(baselinePath, "utf8"), baselinePath);
  const candidate = parseResultFile(await readFile(candidatePath, "utf8"), candidatePath);
  const report = compareResults(baseline, candidate, {
    delta,
    costDelta,
    includeLong: options.get("include-long") === "true",
  });
  const text = renderCompareReport(report, { baseline: baselinePath, candidate: candidatePath });
  if (options.has("json")) log(JSON.stringify(report, null, 2));
  else log(text.trimEnd());
  const reportPath = options.get("report");
  if (reportPath) await writeFile(reportPath, text, "utf8");
  return report.passes ? 0 : 1;
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
