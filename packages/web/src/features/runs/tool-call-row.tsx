// A tool call and its result as one replay row (issue #9): the tool, its risk tier, how long the
// call took from call to result and whether the result was an error, with the input and the
// result each behind their own details. A call with no result yet says so.

import { formatTime } from "../../format.js";
import { useT } from "../../i18n/i18n-provider.js";
import type { LedgerRow } from "./ledger-rows.js";
import { formatSpan } from "./run-activity.js";
import { EvidenceLink, JsonDetails } from "./run-event-row.js";

type ToolRow = Extract<LedgerRow, { kind: "tool" }>;

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

export function ToolCallRow({
  row,
  evidenceUrl,
}: {
  row: ToolRow;
  evidenceUrl?: ((path: string) => string) | undefined;
}) {
  const t = useT();
  const { call, result } = row;
  const facts = [
    str(call.payload.toolName),
    str(call.payload.riskLevel),
    result
      ? row.durationMs === undefined
        ? undefined
        : formatSpan(row.durationMs)
      : t("runEventRow.tool.noResult"),
  ].filter((fact): fact is string => fact !== undefined);
  return (
    <li
      className={`event tool_call tool-pair${row.isError ? " tool-error" : ""}${result ? "" : " tool-open"}`}
      data-tool-use-id={str(call.payload.toolUseId)}
    >
      <div className="event-head">
        <span className="seq">#{call.seq}</span>
        <span className="kind tool_call">{call.kind}</span>
        <span className="muted small">{formatTime(call.ts)}</span>
        <span className="event-summary">{facts.join(" · ")}</span>
        {row.isError ? (
          <span className="kind tool-error-badge">{t("runEventRow.summary.error")}</span>
        ) : null}
      </div>
      <JsonDetails payload={call.payload} label={t("runEventRow.label.input")} />
      {result ? (
        <>
          <JsonDetails
            payload={result.payload}
            label={t("runEventRow.tool.resultAt", { seq: result.seq })}
          />
          <EvidenceLink payload={result.payload} evidenceUrl={evidenceUrl} />
        </>
      ) : null}
    </li>
  );
}
