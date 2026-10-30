#!/usr/bin/env node
// Comparison R of the 2026-10-17 protocol (ADR-0041 decision 10): hybrid retrieval against the
// FTS5 baseline, one knob at a time. This file prepares the campaign and grades its reports; it
// runs nothing and calls no model. No campaign has been run and no result exists.
//
//   npm run retrieval-eval -- plan                 sample size (evals/power.ts) and the ceiling
//   npm run retrieval-eval -- check                validate evals/tasks/retrieval-v1.json
//   npm run retrieval-eval -- schedule [--repetitions 5]
//   npm run retrieval-eval -- rows <report-dir>... --arm <arm> [--out <file.jsonl>]
//   npm run retrieval-eval -- decide <baseline.jsonl> <candidate.jsonl> [--json]
//
// The executor that writes the reports is `evals/retrieval-campaign.acceptance.test.ts`; it skips
// unless EVAL_CAMPAIGN=retrieval-v1 is set with an arm and Docker, and either a model or
// EVAL_DRY_RUN=scripted (protocol amendment 1).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dryRunNote, parseArgs, readObservations } from "./campaign/cli.js";
import { decideRetrieval } from "./campaign/decide.js";
import { parseResultFile } from "./compare/result-row.js";
import { RETRIEVAL_ARMS, retrievalArmOrder } from "./retrieval/arms.js";
import { retrievalRows } from "./retrieval/grade.js";
import { renderRetrievalPlan, retrievalPlan } from "./retrieval/plan.js";
import {
  activeItems,
  loadRetrievalTaskSet,
  validateRetrievalTaskSet,
} from "./retrieval/task-set.js";

const USAGE =
  "usage: npm run retrieval-eval -- plan | check | schedule [--repetitions N] | rows <report-dir>... --arm <arm> [--out <file.jsonl>] | decide <baseline.jsonl> <candidate.jsonl> [--json]";

export function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): number {
  const [command, ...rest] = argv;
  const { positional, options } = parseArgs(rest);
  const set = loadRetrievalTaskSet(options.get("tasks") || undefined);
  if (command === "plan") {
    log(renderRetrievalPlan(retrievalPlan(set)).trimEnd());
    return 0;
  }
  if (command === "check") {
    const problems = validateRetrievalTaskSet(set);
    for (const p of problems) log(p);
    log(problems.length === 0 ? `${set.name} ${set.version}: ok` : `${problems.length} problems`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "schedule") {
    const repetitions = Number(options.get("repetitions") ?? set.defaults.repeats);
    retrievalArmOrder(repetitions).forEach((order, i) => log(`${i + 1}: ${order.join(", ")}`));
    return 0;
  }
  if (command === "rows") {
    const arm = options.get("arm");
    if (positional.length === 0 || !RETRIEVAL_ARMS.some((a) => a.arm === arm)) {
      log(USAGE);
      return 2;
    }
    const rows = retrievalRows(set, readObservations(positional)).filter((r) => r.arm === arm);
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
    const report = decideRetrieval({
      baseline,
      candidate,
      taskIds: activeItems(set).map((i) => i.id),
      k: set.defaults.repeats,
      delta: set.defaults.delta_pass_rate,
      costDelta: set.defaults.delta_cost,
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
          `overall: ${report.overall.verdict}; strata: ${report.strata.map((s) => `${s.name} ${s.report.verdict}`).join(", ")}`,
        );
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
