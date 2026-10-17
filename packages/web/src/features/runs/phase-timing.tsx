// The run's `phase_timing` spans as a timeline (issue #9), instead of raw log rows behind a
// checkbox. Each span is a row: its phase (and tool), when it started relative to the first
// span, how long it took and how it ended, with a bar on one shared time axis. Spans nest
// (`parentSpanId`) and overlap, so their durations are never added up (`timing.ts`). A span with
// a start and no end is open: still running, or its end was never observed.

import type { RunEvent } from "@deskmates/contracts";
import { useT } from "../../i18n/i18n-provider.js";
import { formatElapsed, formatSpan } from "./run-activity.js";

export interface PhaseSpan {
  spanId: string;
  phase: string;
  parentSpanId?: string;
  toolName?: string;
  /** Wall-clock start, ms since epoch. */
  startMs: number;
  durationMs?: number;
  outcome?: string;
  /** Nesting depth under its parent spans, 0 for a top-level span. */
  depth: number;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Spans from the run's phase-timing samples, ordered by start. */
export function phaseSpans(events: readonly RunEvent[]): PhaseSpan[] {
  const byId = new Map<string, Omit<PhaseSpan, "depth">>();
  for (const event of events) {
    const p = event.payload;
    if (event.kind !== "log" || p.source !== "phase_timing") continue;
    const spanId = str(p.spanId);
    const phase = str(p.phase);
    const at = Date.parse(str(p.at) ?? event.ts);
    if (!spanId || !phase || Number.isNaN(at)) continue;
    const span = byId.get(spanId) ?? { spanId, phase, startMs: at };
    const parentSpanId = str(p.parentSpanId);
    const toolName = str(p.toolName);
    const outcome = str(p.outcome);
    if (parentSpanId) span.parentSpanId = parentSpanId;
    if (toolName) span.toolName = toolName;
    if (p.edge === "start") span.startMs = at;
    if (p.edge === "end") {
      const duration = typeof p.durationMs === "number" ? Math.max(0, p.durationMs) : undefined;
      if (duration !== undefined) span.durationMs = duration;
      if (outcome) span.outcome = outcome;
      // Only an end seen: its start is the end minus the duration.
      if (!byId.has(spanId) && duration !== undefined) span.startMs = at - duration;
    }
    byId.set(spanId, span);
  }
  const depth = (span: Omit<PhaseSpan, "depth">, seen = new Set<string>()): number => {
    const parent = span.parentSpanId ? byId.get(span.parentSpanId) : undefined;
    if (!parent || seen.has(parent.spanId)) return 0;
    seen.add(parent.spanId);
    return 1 + depth(parent, seen);
  };
  return [...byId.values()]
    .map((span) => ({ ...span, depth: depth(span) }))
    .sort((a, b) => a.startMs - b.startMs || a.depth - b.depth);
}

export function PhaseTimingTimeline({ events }: { events: readonly RunEvent[] }) {
  const t = useT();
  const spans = phaseSpans(events);
  if (spans.length === 0) return <p className="muted small">{t("phaseTiming.none")}</p>;
  const origin = Math.min(...spans.map((s) => s.startMs));
  const end = Math.max(...spans.map((s) => s.startMs + (s.durationMs ?? 0)));
  const total = Math.max(1, end - origin);
  return (
    <ol className="phase-timing" aria-label={t("phaseTiming.list")}>
      {spans.map((span) => {
        const left = ((span.startMs - origin) / total) * 100;
        const width = span.durationMs === undefined ? 0 : (span.durationMs / total) * 100;
        return (
          <li
            key={span.spanId}
            className="phase-span"
            data-phase={span.phase}
            data-outcome={span.outcome ?? "open"}
          >
            <span className="phase-span-label" style={{ paddingLeft: `${span.depth}em` }}>
              {span.phase}
              {span.toolName ? <span className="muted"> · {span.toolName}</span> : null}
            </span>
            <span className="phase-span-track" aria-hidden="true">
              <span
                className="phase-span-bar"
                style={{ left: `${left}%`, width: `max(2px, ${width}%)` }}
              />
            </span>
            <span className="phase-span-facts small muted">
              {t("phaseTiming.at", { offset: formatElapsed(span.startMs - origin) })}
              {" · "}
              {span.durationMs === undefined
                ? t("phaseTiming.open")
                : `${formatSpan(span.durationMs)}${span.outcome && span.outcome !== "ok" ? ` · ${span.outcome}` : ""}`}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
