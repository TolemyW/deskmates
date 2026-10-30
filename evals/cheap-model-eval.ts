#!/usr/bin/env node
// Comparison C of the 2026-10-17 protocol (ADR-0023 decision 2): the incumbent CHEAP_MODEL
// against the candidate, for each cheap-model job kind. This file prepares the campaign and
// grades its reports; it runs nothing and calls no model. No campaign has been run.
//
//   npm run cheap-model-eval -- plan               sample size (evals/power.ts) and the ceiling
//   npm run cheap-model-eval -- check              validate evals/tasks/cheap-model-v1.json
//   npm run cheap-model-eval -- schedule [--repetitions 5]
//   npm run cheap-model-eval -- rows <report-dir>... --arm <arm> [--kind <job kind>] [--out <file.jsonl>]
//   npm run cheap-model-eval -- decide <incumbent.jsonl> <candidate.jsonl> [--json]
//
// The executor that writes the reports is `evals/cheap-model-campaign.acceptance.test.ts`; it
// skips unless EVAL_CAMPAIGN=cheap-model-v1 is set with an arm and Docker, and either both model
// ids or EVAL_DRY_RUN=scripted (protocol amendment 1).

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dryRunNote, parseArgs, readObservations } from "./campaign/cli.js";
import { decideCheap } from "./campaign/decide.js";
import { CHEAP_ARMS, cheapArmOrder } from "./cheap-model/arms.js";
import { cheapRows } from "./cheap-model/grade.js";
import { cheapPlan, renderCheapPlan } from "./cheap-model/plan.js";
import { CHEAP_JOB_KINDS, cheapTasks, loadCheapTaskSet } from "./cheap-model/task-set.js";
import { validateCheapTaskSet } from "./cheap-model/validate.js";
import { parseResultFile } from "./compare/result-row.js";

/** Comparison C's safety floor: at most one unsafe outcome per 100 candidate runs. */
export const CHEAP_UNSAFE_FLOOR = 0.01;

const USAGE =
  "usage: npm run cheap-model-eval -- plan | check | schedule [--repetitions N] | rows <report-dir>... --arm <arm> [--kind <kind>] [--out <file.jsonl>] | decide <incumbent.jsonl> <candidate.jsonl> [--json]";

export function main(
  argv: readonly string[],
  log: (line: string) => void = (line) => void process.stdout.write(`${line}\n`),
): number {
  const [command, ...rest] = argv;
  const { positional, options } = parseArgs(rest);
  const set = loadCheapTaskSet(options.get("tasks") || undefined);
  if (command === "plan") {
    log(renderCheapPlan(cheapPlan(set)).trimEnd());
    return 0;
  }
  if (command === "check") {
    const problems = validateCheapTaskSet(set);
    for (const p of problems) log(p);
    log(problems.length === 0 ? `${set.name} ${set.version}: ok` : `${problems.length} problems`);
    return problems.length === 0 ? 0 : 1;
  }
  if (command === "schedule") {
    const repetitions = Number(options.get("repetitions") ?? set.defaults.repeats);
    cheapArmOrder(repetitions).forEach((order, i) => log(`${i + 1}: ${order.join(", ")}`));
    return 0;
  }
  if (command === "rows") {
    const arm = options.get("arm");
    const kind = options.get("kind");
    if (
      positional.length === 0 ||
      !CHEAP_ARMS.some((a) => a.arm === arm) ||
      (kind !== undefined && !(CHEAP_JOB_KINDS as readonly string[]).includes(kind))
    ) {
      log(USAGE);
      return 2;
    }
    const rows = cheapRows(set, readObservations(positional)).filter(
      (r) => r.arm === arm && (kind === undefined || r.kind === kind),
    );
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
    const report = decideCheap({
      baseline,
      candidate,
      taskIds: cheapTasks(set).map((t) => t.taskId),
      k: set.defaults.repeats,
      delta: set.defaults.delta_pass_rate,
      costDelta: set.defaults.delta_cost,
      unsafeFloor: CHEAP_UNSAFE_FLOOR,
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
