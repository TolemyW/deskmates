// The group-round evaluation (ADR-0005 amendment 6, decision 52; issue #12): three arms of one
// build, `parallel`, `in-turn` and `round-v1`, on the group-owner scenarios (campaign B plus the
// `everyone` scenario) and the foundation suite. This file prepares the campaign and reads its
// reports; it runs nothing. No campaign has been run and no result exists.
//
//   npm run group-rounds -- schedule [--repetitions 3]
//       prints the arm order of each repetition (a rotation) and each arm's environment
//   npm run group-rounds -- rows <report-dir>... [--out <file.jsonl>]
//       turns `group-owner-<scenario>.json` reports into `evals/compare.ts` rows, one per
//       scenario and repetition, with the arm and the round fingerprint
//
// Then, per pair of arms: `npm run compare -- <baseline.jsonl> <candidate.jsonl>`. The pairing unit
// is the scenario; every scenario is a short task. Duplicate answers need the judge rubric of the
// issue and are not computed here: `botMessages` is only their upper bound.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUP_ROUND_ARMS,
  armEnvironment,
  armSchedule,
} from "../acceptance/support/group-round-arms.js";
import type { ResultRow } from "./compare/result-row.js";

/** The fields of one `group-owner-<scenario>.json` report this file reads. */
export interface GroupOwnerReport {
  scenario: string;
  routing: string;
  arm?: string;
  passed: boolean;
  answered: boolean;
  totalRuns: number;
  silentRuns: number;
  failedRuns: number;
  msToAnswer: number | null;
  msToFirstReply?: number | null;
  botMessages?: number;
  triageRuns?: number;
  capBreaches?: number;
  runs: { usage: unknown[] }[];
}

/** Input tokens over every run's usage rows; a row without a number counts nothing. */
export function inputTokens(report: Pick<GroupOwnerReport, "runs">): number {
  let total = 0;
  for (const run of report.runs)
    for (const row of run.usage) {
      const value = (row as { inputTokens?: unknown }).inputTokens;
      if (typeof value === "number" && Number.isFinite(value)) total += value;
    }
  return total;
}

/**
 * One `compare.ts` row: success is the scenario's pass (answered, no failed run); the
 * fingerprint holds the decision-52 metrics that can be read from the report. A missing time is
 * left out of the fingerprint rather than written as zero.
 */
export function toResultRow(report: GroupOwnerReport, repeat: number): ResultRow {
  const fingerprint: Record<string, number> = {
    runs: report.totalRuns,
    inputTokens: inputTokens(report),
    silentRuns: report.silentRuns,
    failedRuns: report.failedRuns,
    botMessages: report.botMessages ?? 0,
    triageRuns: report.triageRuns ?? 0,
    capBreaches: report.capBreaches ?? 0,
  };
  if (report.msToAnswer !== null) fingerprint.msToAnswer = report.msToAnswer;
  if (typeof report.msToFirstReply === "number") fingerprint.msToFirstReply = report.msToFirstReply;
  return {
    taskId: `group-owner/${report.scenario}`,
    bucket: "short",
    repeat,
    success: report.passed,
    failureReason: report.passed ? null : report.answered ? "failed_run" : "not_answered",
    fingerprint,
    costUsd: null,
    arm: report.arm ?? report.routing,
    routing: report.routing,
  };
}

/** Rows from report directories, one directory per repetition, in the order given. */
export function rowsFromDirectories(dirs: readonly string[]): ResultRow[] {
  return dirs.flatMap((dir, index) =>
    readdirSync(dir)
      .filter((file) => /^group-owner-.+\.json$/.test(file))
      .sort()
      .map((file) =>
        toResultRow(
          JSON.parse(readFileSync(path.join(dir, file), "utf8")) as GroupOwnerReport,
          index + 1,
        ),
      ),
  );
}

export function renderSchedule(repetitions: number): string {
  const lines = [
    "Group-round evaluation (ADR-0005 amendment 6): one build, one image, three arms.",
    ...GROUP_ROUND_ARMS.map(
      (a) =>
        `- ${a.arm}: ${Object.entries(armEnvironment(a.arm))
          .map(([k, v]) => `${k}=${v}`)
          .join(" ")}`,
    ),
    "Order per repetition:",
    ...armSchedule(repetitions).map((order, i) => `  ${i + 1}: ${order.join(", ")}`),
  ];
  return `${lines.join("\n")}\n`;
}

export function main(argv: readonly string[]): number {
  const [command, ...rest] = argv;
  if (command === "schedule") {
    const at = rest.indexOf("--repetitions");
    const repetitions = at >= 0 ? Number(rest[at + 1]) : 3;
    process.stdout.write(renderSchedule(repetitions));
    return 0;
  }
  if (command === "rows") {
    const at = rest.indexOf("--out");
    const out = at >= 0 ? rest[at + 1] : undefined;
    const dirs = rest.filter((arg, i) => arg !== "--out" && (at < 0 || i !== at + 1));
    if (dirs.length === 0) {
      process.stderr.write("usage: group-rounds rows <report-dir>... [--out <file.jsonl>]\n");
      return 2;
    }
    const text = rowsFromDirectories(dirs)
      .map((row) => JSON.stringify(row))
      .join("\n");
    if (out) writeFileSync(out, `${text}\n`, "utf8");
    else process.stdout.write(`${text}\n`);
    return 0;
  }
  process.stderr.write("usage: group-rounds schedule [--repetitions N] | rows <report-dir>...\n");
  return 2;
}

const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
