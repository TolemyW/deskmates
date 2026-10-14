// What a replay compares. A trajectory replay does not check that the run "went the same way" —
// the fake SDK forces that — it checks that the code took the same *decisions* at the points
// where the sidecar, not the model, is in charge (measurement §5.1, item 2):
//
//   riskLevel    the tier the table gave the call            (`tool_call.payload.riskLevel`)
//   hookDecision what the PreToolUse hook returned           (allow / deny / defer)
//   egress       whether egress stopped it (an outright block or an unanswered/denied site ask)
//   browserLock  whether a human held the workspace browser  (a `takeover` event on the call)
//   inputRedacted whether the ledger copy of the input was redacted
//
// All five are derived from ledger events by the same function on both sides, so a recorded
// trace and a replayed run are read with one set of rules. Nothing here knows which side it is
// looking at; that is what makes the diff meaningful.
//
// A note on `inputRedacted`. The recorded input is already redacted, and the replay feeds that
// redacted input back in, so this field cannot catch redaction being *removed* — the `[redacted]`
// marker is in the input string itself. What it does catch is redaction widening: new code that
// scrubs a field the old code passed through makes the replayed copy carry a marker the recorded
// one does not. That is the direction redaction rules actually change in, and it is exactly the
// kind of behaviour change that has to go through the strategy protocol rather than land quietly.

import type { RiskLevel } from "@deskmates/contracts";
import { REDACTED, type TraceEvent } from "./trace.js";

export type HookOutcome = "allow" | "deny" | "defer";

export interface DecisionPoint {
  /** Position among the run's tool calls, which is how the two sides are matched. */
  index: number;
  /** Ledger seq of the `tool_call` event, so a mismatch can be found in the transcript. */
  seq: number;
  tool: string;
  toolUseId: string;
  riskLevel: RiskLevel | "unknown";
  hookDecision: HookOutcome;
  egress: "allowed" | "blocked";
  browserLock: "granted" | "blocked_by_human";
  inputRedacted: boolean;
}

/** Compared in this order; `tool` is checked first and alone, since a shifted call fails the rest. */
export const DECISION_FIELDS = [
  "riskLevel",
  "hookDecision",
  "egress",
  "browserLock",
  "inputRedacted",
] as const;

export type DecisionField = (typeof DECISION_FIELDS)[number] | "tool" | "present";

export interface Mismatch {
  seq: number;
  tool: string;
  field: DecisionField;
  recorded: string;
  replayed: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function isRiskLevel(value: unknown): value is RiskLevel {
  return value === "L0" || value === "L1" || value === "L2";
}

/**
 * The hook speaks `HookDecision` (allow / deny / defer); a human and a rule speak
 * `ApprovalDecision` (allow_once / allow_always / deny). The ledger carries both, from the
 * sidecar and from the Gateway, so both are normalised to what the hook did with them.
 */
export function normaliseDecision(value: unknown): HookOutcome | undefined {
  switch (value) {
    case "allow":
    case "allow_once":
    case "allow_always":
      return "allow";
    case "deny":
      return "deny";
    case "defer":
      return "defer";
    default:
      return undefined;
  }
}

function containsRedaction(value: unknown): boolean {
  if (typeof value === "string") return value.includes(REDACTED);
  if (Array.isArray(value)) return value.some(containsRedaction);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsRedaction);
  }
  return false;
}

/**
 * Decision points in ledger order. Two passes: the Gateway assigns `seq` on arrival and the
 * sidecar batches its events, so a Gateway-side `rule_matched` can land before the sidecar's
 * `requested` for the same approval. The first pass therefore only learns which tool call each
 * approval id belongs to; the second applies the decisions.
 */
/**
 * The Gateway's connector proxy writes its own `tool_call` / `tool_result` pair per connector
 * call for ledger attribution (ADR-0012 item 7), next to the sidecar's own events for the same
 * call. Only the sidecar's events are decisions the hook took; the proxy's are bookkeeping and
 * must not become decision points or replayed calls. The integrations module writes the same kind
 * of pair (`source: "integration_proxy"`, ADR-0013 item 7) and is skipped for the same reason.
 */
const GATEWAY_ATTRIBUTION_SOURCES: ReadonlySet<string> = new Set([
  "connector_proxy",
  "integration_proxy",
]);

export function isSidecarToolCall(event: TraceEvent): boolean {
  const source = str(event.payload.source);
  return (
    event.kind === "tool_call" && (source === undefined || !GATEWAY_ATTRIBUTION_SOURCES.has(source))
  );
}

export function decisionPoints(events: readonly TraceEvent[]): DecisionPoint[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const approvalToToolUse = new Map<string, string>();
  const pendingEgressAsks = new Map<string, number>();
  const latestCallSeq = new Map<string, number>();
  const egressAsksByCall = new Map<number, Set<string>>();
  const egressApprovals = new Set<string>();
  for (const event of ordered) {
    const toolUseId = str(event.payload.toolUseId);
    if (isSidecarToolCall(event) && toolUseId !== undefined) {
      latestCallSeq.set(toolUseId, event.seq);
    }
    // ADR-0020 records the egress ask before its approval request. Correlate the
    // approval id, not every later approval on this tool call: a shell fetch can
    // pass egress and then be denied for an unrelated L2 side effect.
    if (
      event.kind === "log" &&
      event.payload.source === "pre_tool_use" &&
      event.payload.decision === "ask" &&
      (str(event.payload.reason) ?? "").startsWith("egress_ask:") &&
      toolUseId !== undefined
    ) {
      const callSeq = latestCallSeq.get(toolUseId);
      if (callSeq !== undefined) pendingEgressAsks.set(toolUseId, callSeq);
    }
    if (event.kind !== "approval") continue;
    const approvalId = str(event.payload.approvalId);
    if (
      approvalId !== undefined &&
      toolUseId !== undefined &&
      pendingEgressAsks.has(toolUseId) &&
      (event.payload.phase === "requested" || event.payload.phase === "resumed")
    ) {
      egressApprovals.add(approvalId);
      const callSeq = pendingEgressAsks.get(toolUseId);
      if (callSeq !== undefined) {
        const asks = egressAsksByCall.get(callSeq) ?? new Set<string>();
        asks.add(approvalId);
        egressAsksByCall.set(callSeq, asks);
      }
      pendingEgressAsks.delete(toolUseId);
    }
    if (approvalId !== undefined && toolUseId !== undefined && !approvalToToolUse.has(approvalId)) {
      approvalToToolUse.set(approvalId, toolUseId);
    }
  }

  const points: DecisionPoint[] = [];
  const byToolUse = new Map<string, DecisionPoint>();
  const gatewayEgressDecisions = new Map<string, HookOutcome>();
  const sidecarEgressDecisions = new Map<number, Map<string, HookOutcome>>();
  const outrightEgressBlocks = new Set<number>();

  for (const event of ordered) {
    const payload = event.payload;
    const toolUseId = str(payload.toolUseId);

    if (isSidecarToolCall(event)) {
      const point: DecisionPoint = {
        index: points.length,
        seq: event.seq,
        tool: str(payload.toolName) ?? "",
        toolUseId: toolUseId ?? "",
        riskLevel: isRiskLevel(payload.riskLevel) ? payload.riskLevel : "unknown",
        // The hook allows L0 and L1 without writing an event; a decision event overrides this.
        hookDecision: "allow",
        egress: "allowed",
        browserLock: "granted",
        inputRedacted: containsRedaction(payload.input),
      };
      points.push(point);
      if (toolUseId !== undefined) byToolUse.set(toolUseId, point);
      continue;
    }

    if (event.kind === "log") {
      const source = str(payload.source);
      if (source !== "pre_tool_use" && source !== "can_use_tool") continue;
      const point = toolUseId === undefined ? undefined : byToolUse.get(toolUseId);
      if (point === undefined) continue;
      if (payload.decision === "ask" && (str(payload.reason) ?? "").startsWith("egress_ask:")) {
        // No browser lock can be acquired until this site ask is allowed.
        point.egress = "blocked";
        continue;
      }
      if (payload.decision !== "deny") continue;
      point.hookDecision = "deny";
      if ((str(payload.reason) ?? "").startsWith("egress_blocked")) {
        point.egress = "blocked";
        outrightEgressBlocks.add(point.seq);
      }
      continue;
    }

    if (event.kind === "takeover") {
      // A workspace-wide `takeover` from the Gateway names no tool call; only the hook's own
      // event, written when a browser call was refused the lock, is a decision point.
      const point = toolUseId === undefined ? undefined : byToolUse.get(toolUseId);
      if (point === undefined) continue;
      point.browserLock = "blocked_by_human";
      point.hookDecision = "deny";
      continue;
    }

    if (event.kind === "approval") {
      const approvalId = str(payload.approvalId);
      const phase = str(payload.phase);
      const decision = normaliseDecision(payload.decision);
      if (
        approvalId !== undefined &&
        egressApprovals.has(approvalId) &&
        toolUseId === undefined &&
        (phase === "decided" || phase === "rule_matched") &&
        decision !== undefined
      ) {
        gatewayEgressDecisions.set(approvalId, decision);
      }
      const id =
        toolUseId ?? (approvalId === undefined ? undefined : approvalToToolUse.get(approvalId));
      const point = id === undefined ? undefined : byToolUse.get(id);
      if (point === undefined) continue;
      if (
        toolUseId !== undefined &&
        approvalId !== undefined &&
        egressAsksByCall.get(point.seq)?.has(approvalId)
      ) {
        const outcome =
          phase === "deferred"
            ? "defer"
            : phase === "failed"
              ? "deny"
              : phase === "decided" || phase === "resumed" || phase === "rule_matched"
                ? decision
                : undefined;
        if (outcome !== undefined) {
          const decisions = sidecarEgressDecisions.get(point.seq) ?? new Map<string, HookOutcome>();
          decisions.set(approvalId, outcome);
          sidecarEgressDecisions.set(point.seq, decisions);
        }
      }
      if (phase === "decided" || phase === "rule_matched" || phase === "resumed") {
        if (decision !== undefined) point.hookDecision = decision;
      } else if (phase === "deferred") {
        point.hookDecision = "defer";
      } else if (phase === "failed") {
        // The Gateway never took the request, so the hook failed closed with a reason.
        point.hookDecision = "deny";
      }
    }
  }

  // Resolve each tool-call occurrence, not just its id: SDK resumes reuse ids.
  // A sidecar defer/failed event is the terminal result of that occurrence;
  // a later Gateway answer must not rewrite the stopped attempt's egress.
  for (const point of points) {
    const asks = egressAsksByCall.get(point.seq);
    if (asks === undefined) continue;
    const allowed = [...asks].every(
      (approvalId) =>
        (sidecarEgressDecisions.get(point.seq)?.get(approvalId) ??
          gatewayEgressDecisions.get(approvalId)) === "allow",
    );
    point.egress = allowed && !outrightEgressBlocks.has(point.seq) ? "allowed" : "blocked";
  }

  return points;
}

function fieldValue(point: DecisionPoint, field: (typeof DECISION_FIELDS)[number]): string {
  return String(point[field]);
}

/**
 * Recorded against replayed, matched by order and tool name. A call whose tool name moved is
 * reported once and its other fields are not compared: everything after a shifted call would
 * read as a mismatch and bury the one that matters.
 */
export function diffDecisions(
  recorded: readonly DecisionPoint[],
  replayed: readonly DecisionPoint[],
): Mismatch[] {
  const mismatches: Mismatch[] = [];
  const count = Math.max(recorded.length, replayed.length);
  for (let i = 0; i < count; i += 1) {
    const a = recorded[i];
    const b = replayed[i];
    if (a === undefined || b === undefined) {
      mismatches.push({
        seq: a?.seq ?? b?.seq ?? 0,
        tool: a?.tool ?? b?.tool ?? "",
        field: "present",
        recorded: a === undefined ? "(no call)" : a.tool,
        replayed: b === undefined ? "(no call)" : b.tool,
      });
      continue;
    }
    if (a.tool !== b.tool) {
      mismatches.push({
        seq: a.seq,
        tool: a.tool,
        field: "tool",
        recorded: a.tool,
        replayed: b.tool,
      });
      continue;
    }
    for (const field of DECISION_FIELDS) {
      const recordedValue = fieldValue(a, field);
      const replayedValue = fieldValue(b, field);
      if (recordedValue !== replayedValue) {
        mismatches.push({
          seq: a.seq,
          tool: a.tool,
          field,
          recorded: recordedValue,
          replayed: replayedValue,
        });
      }
    }
  }
  return mismatches;
}
