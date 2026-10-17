// Run startup timeline (ADR-0037). Marks are ledger `log` events with `source: "run_timeline"`,
// recorded by the Gateway and the sidecar where each moment is observed. `buildRunTimeline`
// derives one timeline per attempt on read; a stage whose mark is absent is reported as not
// observed, never as zero and never interpolated from its neighbours.

export const RUN_TIMELINE_VERSION = 1;
export const RUN_TIMELINE_SOURCE = "run_timeline";

/** Marks a process records. Derived stages (`submitted`, upstream request, visible text) are not. */
export type RunTimelineMark =
  | "attempt_started"
  | "sandbox_ready"
  | "sidecar_spawned"
  | "sidecar_started"
  | "query_started"
  | "sdk_init"
  | "first_stream_event"
  | "first_token"
  | "first_text"
  | "sdk_result"
  | "reply_preview_published"
  | "run_ended"
  | "attempt_closed";

/** The payload of one mark event; attributes depend on the mark (ADR-0037 decision 1). */
export interface RunTimelineMarkPayload {
  source: typeof RUN_TIMELINE_SOURCE;
  version: typeof RUN_TIMELINE_VERSION;
  mark: RunTimelineMark;
  /** Wall time in the recording process. */
  at: string;
  [attribute: string]: unknown;
}

export function timelineMark(
  mark: RunTimelineMark,
  at: Date,
  attributes: Record<string, unknown> = {},
): RunTimelineMarkPayload {
  return {
    ...attributes,
    source: RUN_TIMELINE_SOURCE,
    version: RUN_TIMELINE_VERSION,
    mark,
    at: at.toISOString(),
  };
}

/** Every stage of an attempt, in the order a start normally passes them. */
export const RUN_TIMELINE_STAGES = [
  "submitted",
  "routed",
  "attempt_started",
  "sandbox_ready",
  "sidecar_spawned",
  "sidecar_started",
  "query_started",
  "sdk_init",
  "first_upstream_request",
  "first_upstream_byte",
  "first_stream_event",
  "first_token",
  "first_text",
  "first_visible_text",
  "run_ended",
  "attempt_closed",
] as const;

export type RunTimelineStageName = (typeof RUN_TIMELINE_STAGES)[number];

export type AttemptStart = "fresh" | "resume";
export type AttemptSession = "new" | "resumed" | "unknown";
/** `created`: cold container; `attached`: existing container, not cached by this Gateway; `cached`: warm. */
export type AttemptSandbox = "created" | "attached" | "cached" | "unknown";

export interface RunTimelineStage {
  stage: RunTimelineStageName;
  at: string | null;
  observed: boolean;
  /** Why `at` is null: no mark was recorded, or the stage does not exist for this attempt. */
  missing?: "not_observed" | "not_applicable";
  /** From the attempt's `submitted` stage; null unless both were observed. */
  sinceStartMs: number | null;
  /** From the previous observed stage; null for the first observed stage. */
  gapMs: number | null;
}

export interface RunAttemptTimeline {
  attempt: number;
  start: AttemptStart;
  session: AttemptSession;
  sandbox: AttemptSandbox;
  sandboxRetried: boolean;
  /** SDK `api_retry` messages in this attempt (ADR-0023: the SDK is the only retry owner). */
  modelRetries: number;
  /** `run_ended` outcome, else the closing error, else null while the attempt is open. */
  outcome: string | null;
  /** The attempt's process exited or never started (`attempt_closed`), or the run is terminal. */
  closed: boolean;
  stages: RunTimelineStage[];
  /** The stage reached after the longest gap between observed stages. */
  slowestStage: RunTimelineStageName | null;
  /** For an open attempt: the first stage after the last observed one. */
  waitingFor: RunTimelineStageName | null;
  /** Numbers the SDK reported about itself, verbatim; their semantics are the SDK's. */
  sdkReported: {
    numTurns?: number;
    durationApiMs?: number;
    ttftMs?: number;
    ttftStreamMs?: number;
    timeToRequestMs?: number;
  };
  /** The first model response's window, from its `turn_usage` event. */
  firstTurnUsage: {
    inputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreateTokens: number | null;
  } | null;
  /** Server names and statuses the SDK reported at init. */
  mcpServers: { name: string; status: string }[];
}

export interface RunTimeline {
  version: typeof RUN_TIMELINE_VERSION;
  runId: string;
  status: string;
  submittedAt: string;
  finishedAt: string | null;
  /** Submitted to the run's terminal time; null while the run is not terminal. */
  e2eMs: number | null;
  attempts: RunAttemptTimeline[];
}

/** The ledger fields the builder reads; a `RunEvent` or an exported row satisfies it. */
export interface RunTimelineEvent {
  kind: string;
  attempt?: number;
  payload: Record<string, unknown>;
  ts: string;
}

export interface RunTimelineInput {
  runId: string;
  status: string;
  /** Number of attempts the run row says were started. */
  attempt: number;
  createdAt: string;
  finishedAt?: string | null;
  /** When the triggering message was posted, for a thread-message run. */
  submittedAt?: string | null;
  events: readonly RunTimelineEvent[];
}

const TERMINAL = new Set(["succeeded", "silent", "failed", "cancelled", "stopped"]);

function ms(from: string | null, to: string | null): number | null {
  if (from === null || to === null) return null;
  const a = Date.parse(from);
  const b = Date.parse(to);
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNum(value: unknown): number | null {
  return num(value) ?? null;
}

function earliest(current: string | null, candidate: string | undefined): string | null {
  if (candidate === undefined) return current;
  if (current === null) return candidate;
  return Date.parse(candidate) < Date.parse(current) ? candidate : current;
}

export function isTimelineMark(event: RunTimelineEvent): boolean {
  return event.kind === "log" && event.payload.source === RUN_TIMELINE_SOURCE;
}

/**
 * The per-attempt startup timeline of one run (ADR-0037 decisions 1 to 3). Pure: the same ledger
 * always yields the same timeline, so the run detail, the API and the offline report agree.
 */
export function buildRunTimeline(input: RunTimelineInput): RunTimeline {
  const submittedAt = input.submittedAt ?? input.createdAt;
  const finishedAt = input.finishedAt ?? null;
  const terminal = TERMINAL.has(input.status);
  let attempts = Math.max(1, input.attempt);
  for (const event of input.events) attempts = Math.max(attempts, event.attempt ?? 1);

  const timelines: RunAttemptTimeline[] = [];
  for (let n = 1; n <= attempts; n += 1) {
    const events = input.events.filter((event) => (event.attempt ?? 1) === n);
    const marks = new Map<string, Record<string, unknown>>();
    let firstRequest: string | null = null;
    let firstByte: string | null = null;
    let firstPost: string | null = null;
    let modelRetries = 0;
    let firstTurnUsage: RunAttemptTimeline["firstTurnUsage"] = null;
    for (const event of events) {
      const p = event.payload;
      if (isTimelineMark(event)) {
        const mark = str(p.mark);
        // The first record of a mark wins; a redelivered or repeated mark does not move it.
        if (mark !== undefined && !marks.has(mark)) marks.set(mark, p);
      } else if (event.kind === "log" && p.source === "phase_timing") {
        if (p.requestKind === "count_tokens") continue;
        if (p.phase === "model_request" && p.edge === "start")
          firstRequest = earliest(firstRequest, str(p.at));
        if (p.phase === "model_first_byte" && p.edge === "end" && p.outcome === "ok")
          firstByte = earliest(firstByte, str(p.at));
      } else if (event.kind === "log" && p.tool === "thread_post" && str(p.messageId)) {
        firstPost = earliest(firstPost, event.ts);
      } else if (event.kind === "model_retry") {
        modelRetries += 1;
      } else if (event.kind === "turn_usage" && p.turn === 1 && firstTurnUsage === null) {
        firstTurnUsage = {
          inputTokens: nullableNum(p.inputTokens),
          cacheReadTokens: nullableNum(p.cacheReadTokens),
          cacheCreateTokens: nullableNum(p.cacheCreateTokens),
        };
      }
    }
    const markAt = (mark: RunTimelineMark): string | null => str(marks.get(mark)?.at) ?? null;
    const started = marks.get("attempt_started");
    const start: AttemptStart = n === 1 ? "fresh" : "resume";
    const ended = marks.get("run_ended");
    const closedMark = marks.get("attempt_closed");

    const reference = n === 1 ? submittedAt : (str(started?.readyAt) ?? null);
    let visible: string | null = firstPost;
    visible = earliest(visible, markAt("reply_preview_published") ?? undefined);
    if (ended?.replyPosted === true) visible = earliest(visible, str(ended.at));

    const sidecar = marks.get("sidecar_started");
    const at: Record<RunTimelineStageName, string | null> = {
      submitted: reference,
      routed: n === 1 ? input.createdAt : null,
      attempt_started: markAt("attempt_started"),
      sandbox_ready: markAt("sandbox_ready"),
      sidecar_spawned: markAt("sidecar_spawned"),
      sidecar_started: str(sidecar?.processStartedAt) ?? markAt("sidecar_started"),
      query_started: markAt("query_started"),
      sdk_init: markAt("sdk_init"),
      first_upstream_request: firstRequest,
      first_upstream_byte: firstByte,
      first_stream_event: markAt("first_stream_event"),
      first_token: markAt("first_token"),
      first_text: markAt("first_text"),
      first_visible_text: visible,
      run_ended: markAt("run_ended"),
      attempt_closed: markAt("attempt_closed"),
    };

    const stages: RunTimelineStage[] = [];
    let previous: string | null = null;
    let slowest: { stage: RunTimelineStageName; gap: number } | null = null;
    let lastObserved = -1;
    RUN_TIMELINE_STAGES.forEach((stage, index) => {
      const when = at[stage];
      if (when === null) {
        stages.push({
          stage,
          at: null,
          observed: false,
          missing: stage === "routed" && n > 1 ? "not_applicable" : "not_observed",
          sinceStartMs: null,
          gapMs: null,
        });
        return;
      }
      const gapMs = ms(previous, when);
      // Terminal stages measure how long the run kept going, not a wait before an answer.
      if (gapMs !== null && stage !== "attempt_closed" && (!slowest || gapMs > slowest.gap))
        slowest = { stage, gap: gapMs };
      stages.push({ stage, at: when, observed: true, sinceStartMs: ms(reference, when), gapMs });
      previous = when;
      lastObserved = index;
    });

    const closed = closedMark !== undefined || (terminal && n === attempts);
    let waitingFor: RunTimelineStageName | null = null;
    if (!closed) {
      const next = RUN_TIMELINE_STAGES.slice(lastObserved + 1).find(
        (stage) => stage !== "routed" && at[stage] === null,
      );
      waitingFor = next ?? null;
    }
    const result = marks.get("sdk_result");
    const init = marks.get("sdk_init");
    const sdkReported: RunAttemptTimeline["sdkReported"] = {};
    const reported: [keyof RunAttemptTimeline["sdkReported"], unknown][] = [
      ["numTurns", result?.numTurns],
      ["durationApiMs", result?.durationApiMs],
      ["ttftMs", result?.ttftMs],
      ["ttftStreamMs", result?.ttftStreamMs],
      ["timeToRequestMs", result?.timeToRequestMs],
    ];
    for (const [key, value] of reported) {
      const v = num(value);
      if (v !== undefined) sdkReported[key] = v;
    }
    const servers = Array.isArray(init?.mcpServers) ? init.mcpServers : [];
    timelines.push({
      attempt: n,
      start,
      session:
        started?.session === "new" || started?.session === "resumed" ? started.session : "unknown",
      sandbox: (["created", "attached", "cached"] as const).includes(
        marks.get("sandbox_ready")?.sandbox as "created",
      )
        ? (marks.get("sandbox_ready")?.sandbox as AttemptSandbox)
        : "unknown",
      sandboxRetried: marks.get("sandbox_ready")?.sandboxRetried === true,
      modelRetries,
      outcome: str(ended?.outcome) ?? str(closedMark?.error) ?? null,
      closed,
      stages,
      slowestStage: (slowest as { stage: RunTimelineStageName } | null)?.stage ?? null,
      waitingFor,
      sdkReported,
      firstTurnUsage,
      mcpServers: servers.flatMap((s: unknown) => {
        if (!s || typeof s !== "object") return [];
        const { name, status } = s as { name?: unknown; status?: unknown };
        return typeof name === "string" && typeof status === "string" ? [{ name, status }] : [];
      }),
    });
  }
  return {
    version: RUN_TIMELINE_VERSION,
    runId: input.runId,
    status: input.status,
    submittedAt,
    finishedAt,
    e2eMs: terminal ? ms(submittedAt, finishedAt) : null,
    attempts: timelines,
  };
}

/** One stage of one attempt, or undefined when the attempt has no such stage. */
export function timelineStage(
  attempt: RunAttemptTimeline,
  stage: RunTimelineStageName,
): RunTimelineStage | undefined {
  return attempt.stages.find((s) => s.stage === stage);
}
