// The run replay's rows (issue #9). A `tool_call` and the `tool_result` with its `toolUseId` are
// one row, with the call's duration and the result's error state; a result whose call is not
// loaded (an older page) stays a row of its own. Diagnostic logs, the structured telemetry the
// Gateway and sidecar write for measurement (resource observations, phase timing, startup marks,
// lock and context bookkeeping), are left out unless asked for; a log without a source, or one
// that carries text, an error, a warning or a stall, is never diagnostic. Pure, so the order and the pairing are tested
// without React.

import type { RunEvent } from "@deskmates/contracts";

export type LedgerRow =
  | { kind: "event"; event: RunEvent }
  | {
      kind: "tool";
      call: RunEvent;
      result: RunEvent | undefined;
      /** Call to result by ledger time; undefined while the call is open. */
      durationMs: number | undefined;
      isError: boolean;
    };

/** Log sources that always show: the run's own words and what happened to it. */
const VISIBLE_SOURCES: ReadonlySet<unknown> = new Set(["assistant", "stall", "cancel"]);

/** Whether a ledger event is measurement telemetry rather than something the run did. */
export function isDiagnosticEvent(event: RunEvent): boolean {
  if (event.kind !== "log") return false;
  const p = event.payload;
  // A log with no source is not structured telemetry; it shows as it is.
  if (typeof p.source !== "string" || VISIBLE_SOURCES.has(p.source)) return false;
  if (typeof p.text === "string" || typeof p.error === "string") return false;
  if (p.level === "warn" || p.level === "error") return false;
  return true;
}

function toolUseId(event: RunEvent): string | undefined {
  const id = event.payload.toolUseId;
  return typeof id === "string" && id !== "" ? id : undefined;
}

/** Rows in ledger order, a pair at its call's place. */
export function ledgerRows(
  events: readonly RunEvent[],
  options: { diagnostics: boolean } = { diagnostics: false },
): LedgerRow[] {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const calls = new Set(
    sorted.filter((e) => e.kind === "tool_call").flatMap((e) => toolUseId(e) ?? []),
  );
  const results = new Map<string, RunEvent>();
  for (const event of sorted) {
    const id = event.kind === "tool_result" ? toolUseId(event) : undefined;
    if (id !== undefined && calls.has(id) && !results.has(id)) results.set(id, event);
  }
  const paired = new Set([...results.values()]);
  const rows: LedgerRow[] = [];
  for (const event of sorted) {
    if (paired.has(event)) continue;
    if (!options.diagnostics && isDiagnosticEvent(event)) continue;
    const id = event.kind === "tool_call" ? toolUseId(event) : undefined;
    if (id === undefined) {
      rows.push({ kind: "event", event });
      continue;
    }
    const result = results.get(id);
    const start = Date.parse(event.ts);
    const end = result ? Date.parse(result.ts) : Number.NaN;
    rows.push({
      kind: "tool",
      call: event,
      result,
      durationMs: Number.isNaN(start) || Number.isNaN(end) ? undefined : Math.max(0, end - start),
      isError: result?.payload.isError === true,
    });
  }
  return rows;
}

/** How many ledger events the rows show: a pair counts its call and its result. */
export function eventsShown(rows: readonly LedgerRow[]): number {
  return rows.reduce((n, row) => n + (row.kind === "tool" && row.result ? 2 : 1), 0);
}
