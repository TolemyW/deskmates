// The markdown a replay run leaves behind. One table per trace, one summary line at the top, and
// a sentence saying what a mismatch means, because the reader of a CI artifact is not always the
// person who changed the code.

import type { TraceReplayResult } from "./replay-run.js";

export interface ReportMeta {
  /** Usually `new Date().toISOString()`; a parameter so the report is reproducible in a test. */
  generatedAt: string;
  /** Git sha of the code the traces were replayed against, when the caller knows it. */
  gitSha?: string;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

export function renderReport(results: readonly TraceReplayResult[], meta: ReportMeta): string {
  const identical = results.filter((r) => r.identical).length;
  const unsupported = results.filter((r) => r.unsupported !== undefined).length;
  const mismatched = results.length - identical - unsupported;
  const lines: string[] = [];

  lines.push("# Trajectory replay");
  lines.push("");
  lines.push(
    `${results.length} trace(s) replayed at ${meta.generatedAt}${meta.gitSha ? ` against ${meta.gitSha}` : ""}: ` +
      `${identical} identical, ${mismatched} with mismatches` +
      `${unsupported > 0 ? `, ${unsupported} unsupported` : ""}.`,
  );
  lines.push("");
  lines.push(
    "A mismatch is either an intended behaviour change — then it goes through the strategy " +
      "protocol in `docs/design/measurement-2026-09-20.md` §5.2, paired A/B against the baseline " +
      "— or a regression (§5.1).",
  );
  lines.push("");

  for (const result of results) {
    lines.push(`## ${result.runId}`);
    lines.push("");
    const source = result.file === undefined ? "" : ` (\`${result.file}\`)`;
    lines.push(
      `${result.recorded.length} decision point(s), run outcome \`${result.outcome}\`${source}.`,
    );
    lines.push("");
    if (result.error !== undefined) {
      lines.push(`**The replay itself failed:** ${result.error}`);
      lines.push("");
    }
    if (result.unsupported !== undefined) {
      // Not a diff and not a pass: the trace does not carry what a faithful replay needs, and
      // diffing it anyway would report a decision change the code never made.
      lines.push(`**unsupported:** ${result.unsupported}`);
      lines.push("");
      continue;
    }
    if (result.mismatches.length === 0 && result.error === undefined) {
      lines.push("identical");
      lines.push("");
      continue;
    }
    lines.push("| seq | tool | field | recorded | replayed |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const m of result.mismatches) {
      lines.push(
        `| ${m.seq} | ${escapeCell(m.tool)} | ${m.field} | ${escapeCell(m.recorded)} | ${escapeCell(m.replayed)} |`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}
