// Replay one trace through the current sidecar code. Zero tokens and zero containers: the fake
// SDK plays the recorded trajectory back, the sidecar's fake Gateway answers with the recorded
// decisions, and the events the run produces are read with the same `decisionPoints` rules as
// the recording. Everything the run would otherwise reach — model, Gateway, browser, filesystem
// — is a test double, so the only thing under test is the sidecar's own judgement.
//
// The sidecar is imported by module path rather than through `@deskmates/sidecar`'s entry point on
// purpose: the entry point pulls in `real-deps.ts` and with it the real Agent SDK runtime, and
// nothing in a replay may be able to reach a model.

import {
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type RunEnded,
  type SidecarEvent,
  type StartRunRequest,
  type ToolAction,
} from "@deskmates/contracts";
import type { SidecarDeps } from "@deskmates/sidecar/deps.js";
import { isBrowserTool } from "@deskmates/sidecar/risk-tier.js";
import { runOnce } from "@deskmates/sidecar/run-once.js";
import {
  type FakeGatewayOptions,
  createFakeGateway,
} from "@deskmates/sidecar/testing/fake-gateway.js";
import { createMemoryFs } from "@deskmates/sidecar/testing/in-memory-fs.js";
import { type ScriptStep, createFakeSdk } from "@deskmates/testkit";
import {
  type DecisionPoint,
  type HookOutcome,
  type Mismatch,
  decisionPoints,
  diffDecisions,
  isSidecarToolCall,
  normaliseDecision,
} from "./decisions.js";
import { type RunTrace, type TraceEvent, rebuildMemoryIndex, rebuildSkillSet } from "./trace.js";

/** Stand-ins for the run's credentials. Nothing in a replay may reach a real endpoint. */
const REPLAY_BASE_URL = "http://replay.invalid";
const REPLAY_TOKEN = "replay-not-a-token";

/** What the recorded run's SOUL.md said is not in the ledger and does not change a decision. */
const REPLAY_SOUL = "Replay: the bot's SOUL.md is not part of the ledger.";

export interface TraceReplayResult {
  runId: string;
  /** Path the trace was read from, when it came from a file. */
  file?: string;
  identical: boolean;
  mismatches: Mismatch[];
  recorded: DecisionPoint[];
  replayed: DecisionPoint[];
  /** What `runOnce` reported this time; not a decision point, but worth putting in the report. */
  outcome: RunEnded["outcome"] | "error";
  /** Set when the replay itself threw, which is a failure of the replay and not a diff. */
  error?: string;
  /**
   * Why this trace could not be replayed faithfully, when it could not. A resumed run needs
   * fields the ledger does not always keep; without them the replay would start the second
   * attempt with a trigger the recorded one never had, and every decision after it would diff for
   * a reason that has nothing to do with the code under test. Saying so is the honest answer, so
   * an unsupported trace is reported and does not fail the run (QA-02).
   */
  unsupported?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The final assistant text the recorded run ended on: `RunSummary` when it parsed, else the text. */
export function endSummary(trace: RunTrace): string {
  const summary = trace.run.summary;
  if (summary !== undefined) {
    return `${summary.reply}\n\`\`\`json\n${JSON.stringify(summary)}\n\`\`\``;
  }
  const texts = trace.events.filter(
    (e) => e.kind === "log" && str(e.payload.source) === "assistant",
  );
  return str(texts[texts.length - 1]?.payload.text) ?? "";
}

/**
 * The fake SDK script that reproduces the recorded trajectory: every `thinking` block, every
 * assistant text, and every tool call with the input it was made with and the result it got.
 * A denied call's recorded result is the deny reason; the fake SDK ignores a script's `result`
 * when the hook denies the call, so passing it back is harmless and keeps the step honest.
 */
export function scriptFromTrace(trace: RunTrace): ScriptStep[] {
  const results = new Map<string, { content: string; isError: boolean }>();
  for (const event of trace.events) {
    if (event.kind !== "tool_result") continue;
    const id = str(event.payload.toolUseId);
    if (id === undefined) continue;
    results.set(id, {
      content: typeof event.payload.content === "string" ? event.payload.content : "",
      isError: event.payload.isError === true,
    });
  }

  const steps: ScriptStep[] = [];
  for (const event of [...trace.events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind === "thinking") {
      steps.push({ type: "thinking", text: str(event.payload.text) ?? "" });
      continue;
    }
    if (event.kind === "log" && str(event.payload.source) === "assistant") {
      steps.push({ type: "text", text: str(event.payload.text) ?? "" });
      continue;
    }
    if (!isSidecarToolCall(event)) continue;
    const id = str(event.payload.toolUseId) ?? "";
    const result = results.get(id);
    steps.push({
      type: "tool_call",
      name: str(event.payload.toolName) ?? "",
      input: record(event.payload.input),
      ...(result === undefined ? {} : { result: result.content }),
      ...(result?.isError === true ? { isError: true } : {}),
    });
  }

  const usage = trace.usage[0];
  steps.push({
    type: "end",
    summary: endSummary(trace),
    ...(usage === undefined
      ? {}
      : {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheCreateTokens: usage.cacheCreateTokens,
          },
        }),
  });
  return steps;
}

export interface RecordedApproval {
  approvalId: string;
  decision: HookOutcome;
  reason?: string;
}

/**
 * The answers *one sidecar process* got, in the order it asked for them. Approval ids are minted
 * per process, so a replay cannot match on them; it matches on order, which is the same order the
 * hook asks in as long as the trajectory is the same — and the trajectory is forced.
 *
 * `decided` is the sidecar reporting what the wait returned, `rule_matched` the Gateway answering
 * from a stored rule, `deferred` the short wait running out, `failed` the Gateway refusing the
 * request. All end up as one answer the fake Gateway can give.
 *
 * Only the sidecar's own approval events count, which is what `toolUseId` identifies: the Gateway
 * writes a `decided` event of its own when a human answers, and for a parked run that lands
 * *after* the process that asked has exited. Reading it as that process's answer turns a run that
 * deferred into a run that was allowed, and the resumed attempt then disappears (QA-02).
 */
export function recordedApprovals(trace: RunTrace, attempt?: number): RecordedApproval[] {
  const order: string[] = [];
  const decisions = new Map<string, RecordedApproval>();
  for (const event of [...trace.events].sort((a, b) => a.seq - b.seq)) {
    if (event.kind !== "approval") continue;
    if (attempt !== undefined && event.attempt !== attempt) continue;
    const approvalId = str(event.payload.approvalId);
    // A Gateway-originated approval event names no tool call; a sidecar one always does.
    if (approvalId === undefined || str(event.payload.toolUseId) === undefined) continue;
    const phase = str(event.payload.phase);
    if (phase === "requested" || phase === "posted" || phase === "rule_matched") {
      if (!order.includes(approvalId)) order.push(approvalId);
    }
    const reason = str(event.payload.reason);
    const base = { approvalId, ...(reason === undefined ? {} : { reason }) };
    if (phase === "decided" || phase === "rule_matched") {
      const decision = normaliseDecision(event.payload.decision);
      if (decision !== undefined) decisions.set(approvalId, { ...base, decision });
    } else if (phase === "deferred") {
      decisions.set(approvalId, { ...base, decision: "defer" });
    } else if (phase === "failed") {
      decisions.set(approvalId, { ...base, decision: "deny" });
    }
  }
  return order.map((id) => decisions.get(id)).filter((d): d is RecordedApproval => d !== undefined);
}

export interface RecordedLock {
  granted: boolean;
  waitMessage: string;
}

/**
 * Whether the workspace browser was free at each browser call that *asked for it*, in the order
 * the asking happened.
 *
 * The qualifier is the whole point. The `PreToolUse` hook checks egress before it acquires the
 * lock, so a navigation the allowlist stopped never reaches the Gateway for a lock at all. Queuing
 * an answer for it anyway shifts every later answer by one, and the replay then reports a lock
 * behaving differently when nothing about the lock changed (QA-01). A browser call whose recorded
 * decision was `egress: blocked` is therefore not in this sequence.
 */
export function recordedBrowserLocks(
  trace: RunTrace,
  points: readonly DecisionPoint[],
): RecordedLock[] {
  const waitMessages = new Map<string, string>();
  for (const event of trace.events) {
    if (event.kind !== "takeover") continue;
    const id = str(event.payload.toolUseId);
    const message = str(event.payload.waitMessage);
    if (id !== undefined && message !== undefined) waitMessages.set(id, message);
  }
  return points
    .filter((p) => isBrowserTool(p.tool) && p.egress !== "blocked")
    .map((p) => ({
      granted: p.browserLock !== "blocked_by_human",
      waitMessage: waitMessages.get(p.toolUseId) ?? HUMAN_HOLDS_BROWSER_MESSAGE,
    }));
}

/** The `StartRunRequest` the recorded run was started with, as far as the trace can say. */
export function requestFromTrace(trace: RunTrace): StartRunRequest {
  const request: StartRunRequest = {
    runId: trace.run.id,
    botId: trace.run.botId,
    botName: trace.run.botName,
    workspaceId: trace.run.workspaceId,
    botHomeDir: trace.run.botHomeDir,
    attempt: 1,
    trigger: trace.trigger,
    model: trace.run.model,
    cheapModel: trace.run.cheapModel,
    modelBaseUrl: REPLAY_BASE_URL,
    modelAuthToken: REPLAY_TOKEN,
    gatewayBaseUrl: REPLAY_BASE_URL,
    shortWaitSeconds: trace.shortWaitSeconds,
    maxTurns: trace.maxTurns,
    egressAllowlist: trace.egressAllowlist,
    connectors: trace.connectors,
    tools: trace.tools,
  };
  if (trace.run.threadId !== undefined) request.threadId = trace.run.threadId;
  // ADR-0011 decision 12: the pinned index the run was given, restored from its version set.
  const memoryIndex = rebuildMemoryIndex(trace.config, trace.memoryVersions);
  if (memoryIndex !== undefined) request.memoryIndex = memoryIndex;
  // ADR-0015 decision 7: the skill set the run was given, restored from its recorded refs.
  const skills = rebuildSkillSet(trace.config, trace.skillVersions);
  if (skills !== undefined && skills.length > 0) request.skills = skills;
  return request;
}

/**
 * `SidecarEvent` as posted to the Gateway, read back as the ledger rows it would have become.
 * The seq is reassigned in arrival order, which is what the Gateway does: a sidecar's counter
 * restarts at 1 in every process, so a resumed run's second process would otherwise post a second
 * event 1 and the two attempts would interleave when sorted.
 */
function toTraceEvents(posted: readonly SidecarEvent[]): TraceEvent[] {
  return posted.map((e, index) => ({
    seq: index + 1,
    attempt: e.attempt,
    kind: e.kind,
    payload: e.payload,
    ts: e.ts,
  }));
}

/** The sidecar processes the recorded run used, in order. A run that never parked has one. */
export function recordedAttempts(trace: RunTrace): number[] {
  const seen = new Set<number>();
  for (const event of trace.events) {
    if (event.attempt !== undefined) seen.add(event.attempt);
  }
  if (seen.size === 0) return [1];
  return [...seen].sort((a, b) => a - b);
}

/**
 * The human's answer that started one attempt, as the trace recorded it. Two places hold it and
 * either will do: the Gateway's own `decided` event, written when the decision was taken, and the
 * `resumed` event the resumed sidecar writes when it consumes it. A trace with neither cannot say
 * what the resumed process was told, and is not replayable.
 */
function recordedResumeDecision(
  trace: RunTrace,
  attempt: number,
): "allow_once" | "allow_always" | "deny" | undefined {
  const ordered = [...trace.events].sort((a, b) => a.seq - b.seq);
  const fromResumed = ordered.find(
    (e) => e.kind === "approval" && e.attempt === attempt && str(e.payload.phase) === "resumed",
  );
  const fromDecided = ordered.find(
    (e) =>
      e.kind === "approval" &&
      str(e.payload.phase) === "decided" &&
      str(e.payload.decidedBy) !== undefined,
  );
  const raw = str(fromResumed?.payload.decision) ?? str(fromDecided?.payload.decision);
  if (raw === "allow_once" || raw === "allow_always" || raw === "deny") return raw;
  // A `decided` event normalised to a hook outcome still says which way it went.
  const outcome = normaliseDecision(raw);
  if (outcome === "allow") return "allow_once";
  if (outcome === "deny") return "deny";
  return undefined;
}

/**
 * The lock answers one attempt's calls got. On a resumed attempt the SDK replays the deferred
 * call through the hook before the script runs again, and a browser call acquires the lock there
 * too — but that replayed call writes no `tool_call` event, only the `resumed` one, so it has no
 * decision point of its own and its acquisition has to be put back by hand.
 */
function locksForAttempt(trace: RunTrace, events: readonly TraceEvent[]): RecordedLock[] {
  const answers = recordedBrowserLocks(trace, decisionPoints(events));
  const replayed = events.find(
    (e) =>
      e.kind === "approval" &&
      str(e.payload.phase) === "resumed" &&
      str(e.payload.consumedBy) === "replay",
  );
  // A call refused the lock is denied before it can consume a decision, so a replayed call that
  // got as far as an approval had the browser.
  if (replayed !== undefined && isBrowserTool(str(replayed.payload.toolName) ?? "")) {
    answers.unshift({ granted: true, waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE });
  }
  return answers;
}

export async function replayTrace(trace: RunTrace, file?: string): Promise<TraceReplayResult> {
  const recorded = decisionPoints(trace.events);
  const result: TraceReplayResult = {
    runId: trace.run.id,
    ...(file === undefined ? {} : { file }),
    identical: false,
    mismatches: [],
    recorded,
    replayed: [],
    outcome: "error",
  };

  const attempts = recordedAttempts(trace);
  const eventsByAttempt = new Map<number, TraceEvent[]>(attempts.map((a) => [a, []]));
  for (const event of [...trace.events].sort((a, b) => a.seq - b.seq)) {
    // A Gateway-originated event belongs to the attempt that was current when it was written;
    // for the answers below only the sidecar's own events matter, so an unattributed one is
    // dropped rather than guessed at.
    if (event.attempt === undefined) continue;
    eventsByAttempt.get(event.attempt)?.push(event);
  }

  // Answers for the attempt being replayed; reset at every attempt, because each sidecar process
  // asks from scratch and the ids it mints are its own.
  let approvals: RecordedApproval[] = [];
  let locks: RecordedLock[] = [];
  let nextApproval = 0;
  let nextLock = 0;

  const gatewayOpts: FakeGatewayOptions = {
    approvalResponder: (req) => {
      const answer = approvals[nextApproval];
      nextApproval += 1;
      if (answer === undefined) {
        // The recorded run asked fewer times than this one does. Denying keeps the replay
        // moving and the extra call shows up in the diff as the mismatch it is.
        return {
          type: "approval_response",
          approvalId: req.approvalId,
          decision: "deny",
          reason: "replay: the recorded run has no decision for this call",
        };
      }
      return {
        type: "approval_response",
        approvalId: req.approvalId,
        decision: answer.decision,
        ...(answer.reason === undefined ? {} : { reason: answer.reason }),
      };
    },
    lockResponder: (req) => {
      if (req.op !== "acquire") {
        return { type: "browser_lock_result", runId: req.runId, granted: true };
      }
      const answer = locks[nextLock];
      nextLock += 1;
      if (answer === undefined || answer.granted) {
        return { type: "browser_lock_result", runId: req.runId, granted: true };
      }
      return {
        type: "browser_lock_result",
        runId: req.runId,
        granted: false,
        waitMessage: answer.waitMessage,
      };
    },
  };

  const sdk = createFakeSdk(scriptFromTrace(trace));
  const gateway = createFakeGateway(gatewayOpts);
  const fs = createMemoryFs({ [`${trace.run.botHomeDir}/SOUL.md`]: REPLAY_SOUL });
  // Each read of the clock advances it, so an approval short wait elapses without real sleeping.
  let clock = Date.parse(trace.exportedAt) || Date.parse("2026-01-01T00:00:00Z");
  const deps: SidecarDeps = {
    query: sdk.query,
    tool: sdk.tool,
    createSdkMcpServer: sdk.createSdkMcpServer,
    fetch: gateway.fetch,
    fs,
    now: () => {
      clock += 250;
      return new Date(clock);
    },
    env: { PATH: "/usr/bin", DESKMATES_MAX_TURNS: String(trace.maxTurns) },
    sleep: async () => {},
  };

  /** Answers for one attempt, put in front of the fake Gateway before that attempt runs. */
  function armAnswers(attempt: number): void {
    const events = eventsByAttempt.get(attempt) ?? [];
    approvals = recordedApprovals(trace, attempt);
    locks = locksForAttempt(trace, events);
    nextApproval = 0;
    nextLock = 0;
  }

  try {
    let request = requestFromTrace(trace);
    for (const [index, attempt] of attempts.entries()) {
      armAnswers(attempt);
      const ended = await runOnce(request, deps, {
        approvalPollMs: 1,
        batchDelayMs: 1,
        writeStdout: () => {},
      });
      result.outcome = ended.outcome;
      const next = attempts[index + 1];
      if (next === undefined) break;
      // The recorded run had another process, so this one must have parked for the same reason.
      // If it did not, the diff below says so; building a resume out of a run that did not defer
      // would only bury that.
      if (ended.outcome !== "deferred") break;
      const resumed = resumeRequest(request, ended, gateway, trace, next);
      if (typeof resumed === "string") {
        result.unsupported = resumed;
        result.mismatches = [];
        result.identical = false;
        result.replayed = decisionPoints(toTraceEvents(gateway.events));
        return result;
      }
      request = resumed;
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.replayed = decisionPoints(toTraceEvents(gateway.events));
  result.mismatches = diffDecisions(recorded, result.replayed);
  result.identical = result.mismatches.length === 0 && result.error === undefined;
  return result;
}

/**
 * The `StartRunRequest` the Gateway would build to resume a parked run (`RunLifecycle.resume`):
 * the same run row and SDK session, `attempt` one higher, and an `approval` trigger carrying the
 * human's decision for the call that deferred. Everything but the decision comes from the attempt
 * that just ran — the approval id and tool-use id it parked on, the origin the browser was left
 * on, and the action the hook posted, which is what a retry after a stale `ref` is matched
 * against. The decision itself is the one thing only the ledger knows; without it there is
 * nothing to resume with, and the reason is returned instead of a request (QA-02).
 */
function resumeRequest(
  previous: StartRunRequest,
  ended: RunEnded,
  gateway: { approvals: readonly { approvalId: string; action: ToolAction }[] },
  trace: RunTrace,
  attempt: number,
): StartRunRequest | string {
  if (ended.sdkSessionId === undefined || ended.pendingApprovalId === undefined) {
    return `attempt ${attempt} cannot be replayed: the deferred attempt reported no ${
      ended.sdkSessionId === undefined ? "SDK session" : "pending approval"
    }`;
  }
  const decision = recordedResumeDecision(trace, attempt);
  if (decision === undefined) {
    return `attempt ${attempt} cannot be replayed: the trace does not record what the human decided (no \`decided\` event from the Gateway and no \`resumed\` event from the sidecar)`;
  }
  const action = gateway.approvals.find((a) => a.approvalId === ended.pendingApprovalId)?.action;
  return {
    ...previous,
    attempt,
    sdkSessionId: ended.sdkSessionId,
    trigger: {
      kind: "approval",
      approvalId: ended.pendingApprovalId,
      decision,
      ...(ended.pendingToolUseId === undefined ? {} : { toolUseId: ended.pendingToolUseId }),
      ...(ended.currentOrigin === undefined ? {} : { currentOrigin: ended.currentOrigin }),
      ...(action === undefined
        ? {}
        : {
            deferredAction: {
              toolName: action.toolName,
              ...(action.targetOrigin === undefined ? {} : { targetOrigin: action.targetOrigin }),
              ...(action.argumentPattern === undefined
                ? {}
                : { argumentPattern: action.argumentPattern }),
            },
          }),
    },
  };
}
