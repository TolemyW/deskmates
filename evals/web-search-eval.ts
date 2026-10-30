#!/usr/bin/env node
// The web search comparison of the 2026-10-18 protocol (ADR-0049 decision 13): browser only
// against browser plus `web_search`. This file prepares the campaign and grades its reports; it
// runs nothing and calls no model. No campaign has been run and no result exists.
//
//   npm run web-search-eval -- plan                 sample size (evals/power.ts) and the ceiling
//   npm run web-search-eval -- check                validate evals/tasks/web-search-v1.json
//   npm run web-search-eval -- schedule [--repetitions 5]
//   npm run web-search-eval -- rows <report-dir>... --arm <arm> [--out <file.jsonl>]
//   npm run web-search-eval -- decide <browser.jsonl> <browser-search.jsonl> [--json]
//
// The executor that writes the reports is `evals/web-search-campaign.acceptance.test.ts`; it skips
// unless EVAL_CAMPAIGN=web-search-v1 is set with an arm and Docker, and either a model or
// EVAL_DRY_RUN=scripted.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dryRunNote, parseArgs, readObservations } from "./campaign/cli.js";
import { parseResultFile } from "./compare/result-row.js";
import { WEB_SEARCH_ARMS, webSearchArmOrder } from "./web-search/arms.js";
import { decideWebSearch } from "./web-search/decide.js";
import { webSearchRows } from "./web-search/grade.js";
import { renderWebSearchPlan, webSearchPlan } from "./web-search/plan.js";
import {
  activeItems,
  loadWebSearchTaskSet,
  validateWebSearchTaskSet,
} from "./web-search/task-set.js";

const USAGE =
  "usage: npm run web-search-eval -- plan | check | schedule [--repetitions N] | rows <report-dir>... --arm <arm> [--out <file.jsonl>] | decide <baseline.jsonl> <candidate.jsonl> [--json]";

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a");
const num = (x: number) => (Number.isFinite(x) ? x.toFixed(2) : "n/a");

export function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): number {
  const [command, ...rest] = argv;
  const { positional, options } = parseArgs(rest);
  const set = loadWebSearchTaskSet(options.get("tasks") || undefined);
  if (command === "plan") {
    log(renderWebSearchPlan(webSearchPlan(set)).trimEnd());
    return 0;
  }
  if (command === "check") {
    const problems = validateWebSearchTaskSet(set);
    for (const p of problems) log(p);
    log(problems.length === 0 ? `${set.name} ${set.version}: ok` : `${problems.length} problems`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "schedule") {
    const repetitions = Number(options.get("repetitions") ?? set.defaults.repeats);
    webSearchArmOrder(repetitions).forEach((order, i) => log(`${i + 1}: ${order.join(", ")}`));
    return 0;
  }
  if (command === "rows") {
    const arm = options.get("arm");
    if (positional.length === 0 || !WEB_SEARCH_ARMS.some((a) => a.arm === arm)) {
      log(USAGE);
      return 2;
    }
    const rows = webSearchRows(set, readObservations(positional)).filter((r) => r.arm === arm);
    const text = `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const out = options.get("out");
    if (out) writeFileSync(out, text, "utf8");
    else log(text.trimEnd());
    return 0;
  }
  if (command === "decide") {
    const [baselinePath, candidatePath] = positional;
    if (!baselinePath || !candidatePath) {
      log(USAGE);
      return 2;
    }
    const baseline = parseResultFile(readFileSync(baselinePath, "utf8"), baselinePath);
    const candidate = parseResultFile(readFileSync(candidatePath, "utf8"), candidatePath);
    const report = decideWebSearch({
      baseline,
      candidate,
      taskIds: activeItems(set).map((i) => i.id),
      k: set.defaults.repeats,
      delta: set.defaults.delta_pass_rate,
      costDelta: set.defaults.delta_cost,
      unsafeFloor: set.defaults.unsafe_floor,
    });
    const note = dryRunNote([...baseline, ...candidate]);
    if (options.has("json"))
      log(JSON.stringify(note ? { ...report, dryRun: note } : report, null, 2));
    else {
      if (note) log(note);
      log(`decision: ${report.decision}`);
      for (const r of report.reasons) log(`- ${r}`);
      if (report.overall)
        log(
          `overall: ${report.overall.verdict}; ${report.overall.buckets.map((b) => `${b.scope} ${b.verdict}`).join(", ")}; holdout ${report.strata[0]?.report.verdict ?? "n/a"}`,
        );
      for (const e of report.effect)
        log(
          `${e.arm}: pass ${pct(e.passRate)}, searches/run ${num(e.searches)} (tool ${num(e.toolSearches)}, browser ${num(e.browserSearches)}), pages/run ${num(e.pagesOpened)}, unsafe ${e.unsafe}`,
        );
      for (const s of report.strataRates)
        log(`  ${s.stratum}: ${pct(s.baseline)} -> ${pct(s.candidate)}`);
    }
    return report.decision === "adopt" ? 0 : 1;
  }
  log(USAGE);
  return 2;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return (
    entry !== undefined && path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url))
  );
}

if (isMain()) process.exit(main(process.argv.slice(2)));
