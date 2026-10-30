// The recorded trajectory of one run (measurement §5.1, item 2): everything the ledger holds
// about it plus the inputs the sidecar needs to run it again. A trace is self-contained JSON —
// `evals/traces/<runId>.json` — so a replay needs no Gateway, no database and no model.
//
// Two rules shape what goes in here:
//
//   - Only the operator API is read (`GET /api/runs`, `/api/runs/:id`, `/api/runs/:id/events`,
//     `/api/bots/:id`, `/api/workspaces/:id`). The exporter never touches the Gateway database
//     or an internal route, so a trace can be taken from a running deployment by anyone who can
//     open the web UI.
//   - Redaction already happened on the way in: `run_events.payload_json` is what the sidecar's
//     redactor and the Gateway's approval guard let through. `assertNoSecrets` is a guard against
//     that having failed, not the redactor itself.

import { createHash } from "node:crypto";
import type {
  ApprovalId,
  BotId,
  MemoryIndexBudgets,
  MemoryVersionRef,
  PinnedLine,
  PinnedMemoryIndex,
  RunEventKind,
  RunId,
  RunLane,
  RunSkill,
  RunStatus,
  RunSummary,
  RunTriggerKind,
  RunVisibility,
  SidecarToolName,
  SkillFile,
  ThreadId,
  ThreadMessageDelivery,
  TriggerPayload,
  WorkspaceId,
} from "@deskmates/contracts";
import { deriveRunVisibility, recordedSkillSet, skillHashInput } from "@deskmates/contracts";

/** Bumped when a field a replay depends on changes meaning. Older traces are then re-exported. */
export const TRACE_VERSION = 1;

/** A ledger row, minus the `runId` every row in the file repeats. */
export interface TraceEvent {
  /** Ledger order assigned by the Gateway; unique per run across sidecar and Gateway events. */
  seq: number;
  /** Which sidecar process the event came from; absent on Gateway-originated events. */
  attempt?: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
  ts: string;
}

export interface TraceUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
}

/**
 * How faithfully `trigger` could be rebuilt:
 *
 *   - `run_payload`: the run row captured the payload (cron prompt, webhook body, an approval
 *     resume). The replay starts the run with exactly what the recorded one started with.
 *   - `delivered_messages`: the caller supplied the message slice the wake delivered.
 *   - `trigger_ref`: a thread wake whose delivery is no longer reconstructible from the operator
 *     API (`thread_messages` moves on, `last_seen_seq` with it). The trigger carries the trigger
 *     message body the run row kept, or nothing, and the run's prompt therefore differs from the
 *     recorded one. Harmless for a decision diff — the fake SDK replays the recorded trajectory
 *     whatever the prompt says — and recorded here so nobody reads more into a trace than it has.
 */
export type TriggerSource = "run_payload" | "delivered_messages" | "trigger_ref";

/**
 * Where `run.model` came from:
 *
 *   - `run_config`: `runs.config_json`, stamped when the run started with the bot's override
 *     already resolved. That is the model the run actually ran on, and it cannot change later.
 *   - `bot`: the bot's current model, or an export-time default. A fallback for a run row older
 *     than the Gateway that records the effective model — and a mutable one: re-pointing a bot
 *     changes what such a trace claims about a run that finished months ago (QA-03).
 */
export type ModelSource = "run_config" | "bot";

export interface RunTrace {
  traceVersion: number;
  exportedAt: string;
  /** Base URL of the Gateway the trace came from; provenance only. */
  gateway: string;
  run: {
    id: RunId;
    botId: BotId;
    botName: string;
    /** The bot's role and the workspace's name as exported; absent on a trace from an older Gateway. */
    botRole?: string;
    workspaceName?: string;
    workspaceId: WorkspaceId;
    threadId?: ThreadId;
    lane: RunLane;
    triggerKind: RunTriggerKind;
    triggerRef: string;
    status: RunStatus;
    /** Sidecar processes the recorded run used: 1, plus one per resume. */
    attempt: number;
    model: string;
    /** Whether `model` is the run's own record or the bot's current setting. */
    modelSource: ModelSource;
    cheapModel: string;
    botHomeDir: string;
    summary?: RunSummary;
    /**
     * What the run did that someone can see (issue #70), beside a `status` that keeps its
     * ADR-0005 meaning. As the Gateway reported it, or derived from `events` by the same contracts
     * function when an older Gateway did not. Absent only in traces exported before it existed.
     * `silent_run_cost_share` v2 (measurement §3.6) reads `visibleOutcome`.
     */
    visibility?: RunVisibility;
  };
  /** `runs.config_json`: the full knob configuration the run was started with. */
  config: Record<string, unknown>;
  /** Knobs the replay puts back on the `StartRunRequest`; read out of `config` when it has them. */
  shortWaitSeconds: number;
  maxTurns: number;
  /** The workspace's egress allowlist as it stood at export time. */
  egressAllowlist: string[];
  connectors: string[];
  tools: SidecarToolName[];
  trigger: TriggerPayload;
  triggerSource: TriggerSource;
  usage: TraceUsage[];
  events: TraceEvent[];
  /**
   * The memory entry versions named by `config.memory.versionSet` (ADR-0011 decision 12), fetched
   * from `GET /api/memory/versions`; replay rebuilds the pinned index the run was given from them.
   */
  memoryVersions?: TraceMemoryVersion[];
  /**
   * The skill versions named by `config.skills.set` (ADR-0015 decision 7), fetched from
   * `GET /api/skills/versions`; replay rebuilds the skill set the run was given from them.
   */
  skillVersions?: TraceSkillVersion[];
}

/** One skill version as `GET /api/skills/versions` returns it. */
export interface TraceSkillVersion {
  skillId: string;
  version: number;
  name: string;
  sha256: string;
  files: SkillFile[];
}

/**
 * The skill set the run received, rebuilt from its recorded refs in recorded order. Undefined
 * when the run recorded none, or when a version is missing or its content no longer hashes to
 * the recorded value: replay then says so rather than run with another set.
 */
export function rebuildSkillSet(
  config: Record<string, unknown>,
  versions: readonly TraceSkillVersion[] = [],
): RunSkill[] | undefined {
  const recorded = recordedSkillSet(config);
  if (!recorded) return undefined;
  const byRef = new Map(versions.map((v) => [`${v.skillId}@${v.version}`, v]));
  const set: RunSkill[] = [];
  for (const ref of recorded.set) {
    const v = byRef.get(`${ref.skillId}@${ref.version}`);
    if (!v || v.name !== ref.name) return undefined;
    const sha256 = createHash("sha256").update(skillHashInput(v.files)).digest("hex");
    if (sha256 !== ref.sha256) return undefined;
    set.push({ ...ref, files: v.files.map((f) => ({ path: f.path, content: f.content })) });
  }
  return set;
}

/** One pinned entry version as `GET /api/memory/versions` returns it. */
export interface TraceMemoryVersion {
  entryId: string;
  version: number;
  scope: "task" | "workspace" | "bot";
  body: string;
  authority: PinnedLine["authority"];
  observedAt: string;
  redacted?: boolean;
  learnedBy?: string;
}

/** `runs.config_json.memory`, as the Gateway stamps it at run start. */
export interface RecordedMemoryIndex {
  indexVersion: 1;
  assembledAt: string;
  budgets: MemoryIndexBudgets;
  versionSet: MemoryVersionRef[];
  lines: number;
  /** Absent on runs recorded before the index carried whole-entry counts. */
  counts?: PinnedMemoryIndex["counts"];
}

export function recordedMemoryIndex(
  config: Record<string, unknown>,
): RecordedMemoryIndex | undefined {
  const memory = config.memory as Partial<RecordedMemoryIndex> | undefined;
  if (
    !memory ||
    memory.indexVersion !== 1 ||
    typeof memory.assembledAt !== "string" ||
    !Array.isArray(memory.versionSet) ||
    !memory.budgets
  )
    return undefined;
  return memory as RecordedMemoryIndex;
}

/**
 * The pinned index the run received, rebuilt from the recorded version set in its recorded order.
 * Undefined when the run had none, or when a version is missing or was redacted by a forget:
 * then the exact index cannot be restored and the replay says so rather than guessing.
 */
export function rebuildMemoryIndex(
  config: Record<string, unknown>,
  versions: readonly TraceMemoryVersion[] = [],
): PinnedMemoryIndex | undefined {
  const recorded = recordedMemoryIndex(config);
  if (!recorded) return undefined;
  const byRef = new Map(versions.map((v) => [`${v.entryId}@${v.version}`, v]));
  const sections: PinnedMemoryIndex["sections"] = { workspace: [], bot: [], task: [] };
  let lines = 0;
  for (const ref of recorded.versionSet) {
    const v = byRef.get(`${ref.entryId}@${ref.version}`);
    if (!v || v.redacted) return undefined;
    sections[v.scope].push({
      entryId: v.entryId,
      version: v.version,
      authority: v.authority,
      body: v.body.trimEnd(),
      observedAt: v.observedAt,
      ...(v.learnedBy === undefined ? {} : { learnedBy: v.learnedBy }),
    });
    lines += v.body.trimEnd().split("\n").length;
  }
  const rebuilt = {
    version: 1 as const,
    assembledAt: recorded.assembledAt,
    budgets: { ...recorded.budgets },
    sections,
    versionSet: recorded.versionSet.map((ref) => ({ ...ref })),
    lines,
  };
  // Cast: a run recorded before counts existed received an index without them; leave them
  // absent (unknown) rather than invent numbers. The sidecar accepts an index without counts.
  return (
    recorded.counts ? { ...rebuilt, counts: { ...recorded.counts } } : rebuilt
  ) as PinnedMemoryIndex;
}

// ---------------------------------------------------------------------------
// The operator API shapes the exporter reads. Structural on purpose: `evals/` must not import
// `@deskmates/gateway`, and a trace should still export when the Gateway adds a field.
// ---------------------------------------------------------------------------

export interface ApiRun {
  id: string;
  botId: string;
  threadId?: string;
  lane?: RunLane;
  triggerKind: RunTriggerKind;
  triggerRef?: string;
  status: RunStatus;
  attempt: number;
  createdAt?: string;
  summary?: RunSummary;
  /** `runs.config_json`. */
  config?: Record<string, unknown>;
  /** What fired the run, captured on the row; a thread wake has none. */
  triggerPayload?: Record<string, unknown>;
  /** Issue #70; absent from a Gateway older than the field. */
  visibility?: RunVisibility;
}

export interface ApiRunEvent {
  runId?: string;
  seq: number;
  attempt?: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
  ts: string;
}

export interface ApiBot {
  id: string;
  name: string;
  role?: string;
  workspaceId: string;
  model?: string;
  cheapModel?: string;
  connectors?: readonly string[];
}

export interface ApiWorkspace {
  id: string;
  name?: string;
  egressAllowlist?: readonly string[];
}

export interface TraceSource {
  gateway: string;
  exportedAt: string;
  run: ApiRun;
  events: readonly ApiRunEvent[];
  usage?: readonly TraceUsage[];
  bot: ApiBot;
  workspace: ApiWorkspace;
  /** The message slice the wake delivered, when the caller has it. */
  deliveredMessages?: readonly ThreadMessageDelivery[];
  /** The pinned memory versions the run was given (ADR-0011 decision 12). */
  memoryVersions?: readonly TraceMemoryVersion[];
  /** The skill versions the run was given (ADR-0015 decision 7). */
  skillVersions?: readonly TraceSkillVersion[];
  /** Used when neither the run row nor the bot says; the defaults the Gateway ships with. */
  defaults?: {
    shortWaitSeconds?: number;
    maxTurns?: number;
    model?: string;
    cheapModel?: string;
  };
}

const DEFAULT_SHORT_WAIT_SECONDS = 300;
const DEFAULT_MAX_TURNS = 50;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `/home/<bot>`, the same rule the Gateway's scheduler uses. */
export function botHomeDir(botName: string): string {
  return `/home/${botName}`;
}

function toolsFor(hasThread: boolean): SidecarToolName[] {
  return hasThread ? ["thread_post", "message_bot", "approval_decide"] : [];
}

/**
 * The trigger the replayed run starts with. `thread_message` is the one kind the operator API
 * cannot always give back: the run row keeps no payload for it, so the delivery is rebuilt from
 * whatever is at hand and the loss is recorded in `triggerSource`.
 */
export function reconstructTrigger(
  run: ApiRun,
  deliveredMessages: readonly ThreadMessageDelivery[] | undefined,
): { trigger: TriggerPayload; source: TriggerSource } {
  const payload = run.triggerPayload ?? {};
  if (run.triggerKind === "cron") {
    return { trigger: { kind: "cron", prompt: str(payload.prompt) ?? "" }, source: "run_payload" };
  }
  if (run.triggerKind === "webhook") {
    return { trigger: { kind: "webhook", body: str(payload.body) ?? "" }, source: "run_payload" };
  }
  if (run.triggerKind === "approval") {
    const decision = str(payload.decision);
    const toolUseId = str(payload.toolUseId);
    return {
      trigger: {
        kind: "approval",
        approvalId: (str(payload.approvalId) ?? run.triggerRef ?? "") as ApprovalId,
        decision: decision === "deny" || decision === "allow_always" ? decision : "allow_once",
        ...(toolUseId === undefined ? {} : { toolUseId }),
      },
      source: "run_payload",
    };
  }
  const threadId = (run.threadId ?? "") as ThreadId;
  if (deliveredMessages !== undefined && deliveredMessages.length > 0) {
    return {
      trigger: {
        kind: "thread_message",
        thread: { id: threadId, kind: "chat", title: "" },
        messages: deliveredMessages,
        relayCount: 0,
      },
      source: "delivered_messages",
    };
  }
  return {
    trigger: {
      kind: "thread_message",
      thread: { id: threadId, kind: "chat", title: "" },
      messages: [
        {
          seq: 1,
          authorKind: "human",
          authorId: "",
          authorName: "",
          // The trigger message body when the row kept one; otherwise the run has no text left.
          body: str(payload.body) ?? "",
          attachments: [],
        },
      ],
      relayCount: 0,
    },
    source: "trigger_ref",
  };
}

/** Build a trace out of the operator API responses for one run. Pure; the exporter only fetches. */
export function buildTrace(source: TraceSource): RunTrace {
  const { run, bot, workspace } = source;
  const config = run.config ?? {};
  const { trigger, source: triggerSource } = reconstructTrigger(run, source.deliveredMessages);
  // Recorded run metadata wins over anything still editable. `model` is what the Gateway stamps
  // on the row at run start with the bot's override resolved; `defaultModel` is the older key,
  // written before the effective model was recorded. Only when the row says neither does the
  // bot's current model stand in, and the trace says so in `modelSource` (QA-03).
  const recordedModel = str(config.model) ?? str(config.defaultModel);
  const recordedCheapModel = str(config.cheapModel);
  const trace: RunTrace = {
    traceVersion: TRACE_VERSION,
    exportedAt: source.exportedAt,
    gateway: source.gateway,
    run: {
      id: run.id as RunId,
      botId: run.botId as BotId,
      botName: bot.name,
      botRole: bot.role ?? "",
      workspaceName: workspace.name ?? "",
      workspaceId: workspace.id as WorkspaceId,
      lane: run.lane ?? "interactive",
      triggerKind: run.triggerKind,
      triggerRef: run.triggerRef ?? "",
      status: run.status,
      attempt: run.attempt,
      model: recordedModel ?? bot.model ?? source.defaults?.model ?? "replay-model",
      modelSource: recordedModel === undefined ? "bot" : "run_config",
      cheapModel:
        recordedCheapModel ?? bot.cheapModel ?? source.defaults?.cheapModel ?? "replay-model",
      botHomeDir: botHomeDir(bot.name),
    },
    config,
    shortWaitSeconds:
      num(config.shortWaitSeconds) ??
      source.defaults?.shortWaitSeconds ??
      DEFAULT_SHORT_WAIT_SECONDS,
    maxTurns: num(config.maxTurns) ?? source.defaults?.maxTurns ?? DEFAULT_MAX_TURNS,
    egressAllowlist: [...(workspace.egressAllowlist ?? [])],
    connectors: [...(bot.connectors ?? [])],
    tools: toolsFor(run.threadId !== undefined),
    trigger,
    triggerSource,
    usage: [...(source.usage ?? [])],
    events: [...source.events]
      .sort((a, b) => a.seq - b.seq)
      .map((e) => {
        const event: TraceEvent = { seq: e.seq, kind: e.kind, payload: e.payload, ts: e.ts };
        if (e.attempt !== undefined) event.attempt = e.attempt;
        return event;
      }),
  };
  if (run.threadId !== undefined) trace.run.threadId = run.threadId as ThreadId;
  if (run.summary !== undefined) trace.run.summary = run.summary;
  trace.run.visibility =
    run.visibility ??
    deriveRunVisibility({
      ...(run.summary === undefined ? {} : { reply: run.summary.reply }),
      events: trace.events,
      status: run.status,
      ...(run.threadId === undefined ? {} : { threadId: run.threadId }),
    });
  if (source.memoryVersions !== undefined) trace.memoryVersions = [...source.memoryVersions];
  if (source.skillVersions !== undefined) trace.skillVersions = [...source.skillVersions];
  return trace;
}

// ---------------------------------------------------------------------------
// Export guard
// ---------------------------------------------------------------------------

/**
 * Secret shapes, copied from `packages/gateway/src/approvals/secret-shaped.ts` rather than
 * imported: `evals/` does not depend on the Gateway, and a guard that shares its regexes with the
 * code it is guarding stops being a second opinion. Kept as a detector, not a scrubber — a trace
 * that trips one of these is thrown away, because something upstream of it is broken.
 *
 * The patterns are one of two halves. They find a credential written into prose —
 * `Authorization: Bearer …` inside a shell command, a token in a URL — which is the shape a
 * serialised string has. They cannot find a credential in a *structured* field: a trace is JSON,
 * so `cookie: sid=…` reaches the guard as `"cookie":"sid=…"` and the quote between the key and
 * the colon defeats `\s*[:=]`. The other half is `findSecretsIn`, which walks the parsed object
 * and judges keys by name (QA-04).
 */
const SECRET_PATTERNS: readonly [string, RegExp][] = [
  ["bearer token", /\b(?:bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi],
  ["api key", /\bsk-[A-Za-z0-9_-]{8,}/g],
  [
    "credential variable",
    /\b(?:ANTHROPIC_AUTH_TOKEN|ANTHROPIC_API_KEY|MODEL_AUTH_TOKEN|GATEWAY_SECRETS_KEY)\s*[=:]\s*\S+/g,
  ],
  [
    "credential header",
    /\b(?:cookie|set-cookie|authorization|x-api-key)\s*[:=]\s*["']?[^\r\n'"]+/gi,
  ],
  [
    "credential in a query string",
    /[?&](?:access_token|token|api_key|apikey|key|sig|signature|session|sid|auth)=[^&\s"']+/gi,
  ],
];

export const REDACTED = "[redacted]";

/**
 * Object keys that name a credential, mirroring `packages/sidecar/src/redact.ts` `isSensitiveKey`
 * — copied, not imported, for the same reason the patterns above are. The key is normalised to
 * `snake_case` and matched word by word, so `clientSecret`, `api_secret`, `sessionid`, `passwd`
 * and `x-api-key` are credential names while `runId`, `threadId` and `inputTokens` are not:
 * `token` matches the whole word `token`, never the `token` inside `tokens`.
 */
const SENSITIVE_KEY_WORDS =
  /(^|_)(secrets?|token|passwords?|passwd|cookies?|credentials?|api_?keys?|authorization|session_?id)(_|$)/;

function normaliseKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s.]+/g, "_")
    .toLowerCase();
}

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_WORDS.test(normaliseKey(key));
}

/**
 * One thing the guard caught, said without repeating it. `path` is where in the trace it sits and
 * `kind` is what it looked like; the value itself is never carried, not even a prefix of it. A
 * finding ends up in an error message, on a terminal and in a CI log, and a guard that reacts to
 * a redaction failure by copying the credential into three more places is worse than no guard
 * (QA-05). Whoever has to fix it has the run id and the path, which is what locating it takes.
 */
export interface SecretFinding {
  kind: string;
  /** Where the value sits, e.g. `events[3].payload.headers.cookie`. Empty for a bare string. */
  path: string;
}

function patternFindings(text: string, path: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const [kind, pattern] of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (match[0].includes(REDACTED)) continue;
      findings.push({ kind, path });
    }
  }
  return findings;
}

/** Every secret-shaped string in one piece of text. A match that is only `[redacted]` is not one. */
export function findSecretShaped(text: string): SecretFinding[] {
  return patternFindings(text, "");
}

function joinPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

/**
 * Walk the trace as an object rather than as a blob of JSON: the text patterns on every string,
 * and a check on every key that names a credential. The key walk is what catches
 * `{headers: {cookie: "sid=…"}}`, which no pattern written for prose can see once it has been
 * serialised (QA-04). A value that is already `[redacted]` is what redaction working looks like.
 */
export function findSecretsIn(value: unknown, path = ""): SecretFinding[] {
  if (typeof value === "string") return patternFindings(value, path);
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => findSecretsIn(item, `${path}[${i}]`));
  }
  if (value === null || typeof value !== "object") return [];
  const findings: SecretFinding[] = [];
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = joinPath(path, key);
    if (
      isSensitiveKey(key) &&
      typeof child === "string" &&
      child !== "" &&
      !child.includes(REDACTED)
    ) {
      findings.push({ kind: "credential-named field", path: childPath });
    }
    findings.push(...findSecretsIn(child, childPath));
  }
  return findings;
}

export class TraceSecretError extends Error {
  constructor(
    readonly runId: string,
    readonly findings: readonly SecretFinding[],
  ) {
    // Kinds and paths only. Never the value, never a prefix of it (QA-05).
    const where = findings.map((f) => `${f.kind} at ${f.path || "(trace)"}`).join(", ");
    super(
      `trace ${runId} carries ${findings.length} secret-shaped value(s); redaction upstream of the ledger is broken: ${where}`,
    );
    this.name = "TraceSecretError";
  }
}

/** Throws rather than scrubs: a trace is only worth keeping when nothing had to be taken out. */
export function assertNoSecrets(trace: RunTrace): void {
  const findings = findSecretsIn(trace);
  if (findings.length > 0) throw new TraceSecretError(trace.run.id, findings);
}

export function parseTrace(text: string): RunTrace {
  const value = JSON.parse(text) as RunTrace;
  if (typeof value !== "object" || value === null || !Array.isArray(value.events)) {
    throw new Error("not a RunTrace: no events array");
  }
  if (value.traceVersion !== TRACE_VERSION) {
    throw new Error(
      `trace version ${String(value.traceVersion)} cannot be replayed by this code (expected ${TRACE_VERSION}); re-export it`,
    );
  }
  return value;
}
