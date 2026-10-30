// Messages between the Gateway and the sidecar inside the workspace container.
// The sidecar never decides who is woken and never sees the upstream model key.

import type { ApprovalDecision, HookDecision, RiskLevel, ToolAction } from "./approval.js";
import type { ConnectorToolName } from "./connector.js";
import type { DefaultBotToolName } from "./default-bot.js";
import type { ApprovalId, BotId, RunId, ThreadId, WorkspaceId } from "./ids.js";
import type { IntegrationToolName } from "./integration.js";
import type { DoNotLearnReason, MemorySourceKind, PinnedMemoryIndex } from "./memory.js";
import type { NetworkGrant } from "./network-profile.js";
import type { EffortLevel, ThinkingConfig } from "./reasoning.js";
import type {
  PlatformInterruption,
  PlatformInterruptionReason,
  RunEventKind,
  RunSummary,
  RunUsage,
} from "./run.js";
import type { RunSkill } from "./skill.js";
import type { DeliverableTask } from "./task.js";
import type { ThreadMessageTrigger } from "./thread.js";
import type { VaultToolName } from "./vault.js";

/** Cron and webhook payloads carry plain text; thread wakes carry the unseen message slice. */
export type TriggerPayload =
  | ThreadMessageTrigger
  | { kind: "cron"; prompt: string }
  | { kind: "webhook"; body: string }
  | { kind: "welcome"; prompt: string }
  | {
      kind: "approval";
      approvalId: ApprovalId;
      decision: ApprovalDecision;
      /** For a deny: the reason as the hook would have given it live (ADR-0002 amendment 3, A7). */
      reason?: string;
      /**
       * The SDK tool-use id of the deferred call (`RunEnded.pendingToolUseId`). The sidecar applies
       * the decision to the replayed call with this id or, when that call's result is an error, to
       * the first later call in the same process whose stable dimensions equal `deferredAction`;
       * then the decision is spent. Any other L2 call is judged afresh.
       */
      toolUseId?: string;
      /**
       * Stable dimensions of the deferred action, from the approval row. The replayed call takes
       * the decision only when its own dimensions equal these, and so does the retry.
       */
      deferredAction?: DeferredAction;
      /**
       * The approval row's kind (issue #62 H3). An `egress` decision answers only the egress ask
       * of the replayed call and a `tool` decision only its L2 ask: one call can raise both, and
       * "allow this site" never approves the call's side effect. Absent from an older Gateway;
       * the sidecar then relies on `deferredAction` alone.
       */
      approvalKind?: "tool" | "egress";
      /**
       * Every decided approval of the parked run, the one above first (issue #62 M8). The OpenAI
       * runtime gates one turn's calls in parallel, so a run can park on several approvals and
       * people can decide any of them first; the Gateway resumes on any and hands over every
       * decision made so far. The sidecar applies each to the replayed call with its own tool-use
       * id, in this order; an unchanged undecided call reuses its pending card. Absent from an
       * older Gateway; the sidecar then takes the single decision above.
       */
      decidedApprovals?: ResumeDecision[];
      /**
       * Origin of the page the parked process had navigated to (`RunEnded.currentOrigin`), so the
       * resumed process derives `targetOrigin` for browser calls before it navigates again.
       */
      currentOrigin?: string;
    }
  | { kind: "continuation"; approvalId: ApprovalId; decision: "continue"; handoffPath?: string }
  /** An Admin continued work the workspace budget parked (ADR-0032 decision 7). */
  | { kind: "budget_continuation"; handoffPath?: string }
  /**
   * The platform stopped this run and the Gateway continues it (ADR-0029 decisions 2, 4 and 5).
   * After a drain the SDK replays the deferred call through the hook, which tiers it as usual;
   * after a restart `interruptedCall` names a call whose outcome is unknown. With `freshSession`
   * the old session could not be resumed and this attempt starts a new one from the Gateway's
   * handoff (decision 10).
   */
  | {
      kind: "platform_resume";
      reason: PlatformInterruptionReason;
      interruptedCall?: InterruptedToolCall;
      /** Harness text the Gateway composed; bot and page text inside it stays wrapped. */
      freshSession?: { handoff: string };
      currentOrigin?: string;
    };

/**
 * A tool call the ledger shows started (`tool_call`) and never finished (`tool_result`) when the
 * Gateway restarted (ADR-0029 decision 5). The platform never re-executes it; the resumed attempt
 * is told what its tier means, and an L2 call with the same stable dimensions asks a human again.
 */
export interface InterruptedToolCall {
  toolUseId: string;
  toolName: string;
  riskLevel: RiskLevel;
  /** Stable dimensions of an L2 call, from its approval row, for the post-interruption ask. */
  targetOrigin?: string;
  argumentPattern?: string;
}

/**
 * A short model job (ADR-0023 amendment 1). `vision_probe`: render `code` as a synthetic PNG and
 * ask the model to read it; the Gateway grades the answer. `soul_proposal`: draft a SOUL (create)
 * or targeted edits to `baseBody` (edit) from the operator's instruction; the Gateway applies them.
 * `status_inquiry`: answer a Guest's `question` from `projection`, the Gateway's fixed view of what
 * that Guest may read (ADR-0022 amendment 7 S1, S2); the Gateway appends the answer to the inquiry.
 */
export type ModelJobRequest =
  | { kind: "vision_probe"; code: string }
  /** ADR-0011 amendment 4, A30: label and propose splits for at most 40 notes; decides nothing. */
  | { kind: "memory_organize"; notes: { id: string; body: string }[] }
  /**
   * ADR-0011 amendment 4, A28: judge whether each flagged note is still true against `activity`,
   * the Gateway's bounded excerpt of recent shared threads and tasks; decides nothing itself.
   */
  | {
      kind: "memory_recheck";
      notes: {
        id: string;
        scope: "workspace" | "bot";
        body: string;
        effectiveAt: string;
        lastConfirmedAt?: string;
      }[];
      activity: string;
      /** ADR-0053: frozen, redacted supporting sources; absent on legacy jobs. */
      evidence?: { id: string; at: string; text: string; sha256: string }[];
      asOf?: string;
    }
  /**
   * ADR-0002 amendment 4, B4: judge one pending L2 request. `reviewPackage` is the JSON the
   * Gateway built: the action and the originating human instruction, nothing a tool returned.
   */
  | { kind: "approval_review"; reviewPackage: string }
  | {
      kind: "status_inquiry";
      botName: string;
      role: string;
      projection: string;
      question: string;
    }
  /**
   * ADR-0005 amendment 6, decision 45: plan one round of a group thread from its roster and the
   * human's request (untrusted data); the Gateway validates the plan and decides who wakes.
   */
  | {
      kind: "round_triage";
      roster: { name: string; role: string; owner?: true }[];
      everyone: boolean;
      request: string;
    }
  | {
      kind: "soul_proposal";
      mode: "create" | "edit";
      botName: string;
      role: string;
      instruction: string;
      baseBody: string;
    };

/** The part of a `ToolAction` that identifies "the same action" across processes and snapshots. */
export type DeferredAction = Pick<ToolAction, "toolName" | "targetOrigin" | "argumentPattern">;

/**
 * One decided approval a resume hands over (issue #62 M8): what the `approval` trigger carries
 * for its single decision, for one parked call.
 */
export interface ResumeDecision {
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  /** SDK tool-use id of the parked call the decision is for. */
  toolUseId?: string;
  /** The approval row's kind: an `egress` decision answers only that call's egress ask. */
  approvalKind: "tool" | "egress";
  /** Stable dimensions of the deferred action, from the approval row. */
  deferredAction?: DeferredAction;
  /** For a deny: the reason as the hook would have given it live (ADR-0002 amendment 3, A7). */
  reason?: string;
}

export type BrowserCoordinationMode = "tab-v1" | "origin-v2";
export type BrowserSnapshotMode = "explicit-v1" | "inline-v2";
/**
 * How generic browser code is tiered (ADR-0002 amendment 5, proposed). `name-v1`, the default:
 * by tool name, as before the amendment. `effects-v1`: by the effects its text may have.
 */
export type BrowserCodeApproval = "name-v1" | "effects-v1";
/**
 * Where a run starts (issue #88, ADR-0038). `per-bot`, the default: `botWorkDir(botName)`, and the
 * sidecar's soft guard refuses this bot's obvious writes into another bot's directory (a guard
 * against mistakes, not a security boundary). `shared`: `/work`, as every run did before.
 */
export type BotWorkdirMode = "shared" | "per-bot";

/** ADR-0036 decision 6: what a run is told about its bot's other live lane. */
export interface OtherLaneRun {
  runId: string;
  lane: "interactive" | "background";
  triggerKind: string;
  threadId?: string;
  startedAt: string;
}

/**
 * What the CLI offers the model beyond the sidecar's fixed configuration (ADR-0023 amendment 5).
 * Every field is optional and an absent one changes nothing: the sidecar's own withheld tools stay
 * withheld and the CLI keeps its defaults.
 */
export interface CliSurface {
  /** Built-in CLI tool names withheld on top of the sidecar's fixed list (`disallowedTools`). */
  disallowedTools?: readonly string[];
  /** SDK inline `settings.disableBundledSkills`: drop the skills that ship with the CLI. */
  disableBundledSkills?: boolean;
  /** SDK inline `settings.includeGitInstructions`: the CLI's commit and PR workflow text. */
  includeGitInstructions?: boolean;
  /** SDK inline `settings.skillListingMaxDescChars`: per-skill description cap in the listing. */
  skillListingMaxDescChars?: number;
}

/** Gateway → sidecar supervisor: start one run as one sidecar process. */
export interface StartRunRequest {
  /** Frozen research guidance; absent keeps the prompt of an older run. */
  researchGuidance?: "verify-v1";
  /** Tool-free, isolated presentation job (ADR-0027). */
  presentationSummary?: boolean;
  /** Which presentation job: an approval (ADR-0028, the default) or an Activity run (ADR-0033). */
  presentationKind?: "approval" | "activity";
  /** Tool-free, one-turn model job (ADR-0023 amendment 1); the trigger is not read. */
  modelJob?: ModelJobRequest;
  /**
   * How long the model job may take, in milliseconds: the Gateway's `MODEL_JOB_DEADLINE_MS`
   * (issue #39 item 8), sent only with `modelJob`. Absent means the sidecar's own default of
   * 55 s; the Gateway kills the process five seconds after it.
   */
  modelJobDeadlineMs?: number;
  runId: RunId;
  botId: BotId;
  botName: string;
  /**
   * The bot's configured role, empty when none is set, and its workspace's display name. Both
   * open the static system prompt as one identity line (issue #39 item 4); bot and workspace
   * configuration, never per-run state, so the cached prefix stays byte-identical run to run.
   */
  botRole: string;
  workspaceId: WorkspaceId;
  workspaceName: string;
  threadId?: ThreadId;
  /** `/home/<bot>`; holds SOUL.md, MEMORY.md, diary, skills, .claude. */
  botHomeDir: string;
  /** Present on resume; the sidecar passes it to the SDK as `resume`. */
  sdkSessionId?: string;
  /** Pending cards carried across attempts; reuse only for the same call, kind and action hash. */
  pendingApprovals?: {
    approvalId: ApprovalId;
    toolUseId: string;
    kind: "tool" | "egress";
    actionFingerprint: string;
  }[];
  /**
   * Which sidecar process of this run this is: 1 for the first, one more on every resume. The
   * sidecar's event counter restarts at 1 in every process, so the Gateway dedups redelivered
   * events on `(run, attempt, seq)`, never on `(run, seq)` alone.
   */
  attempt: number;
  trigger: TriggerPayload;
  /**
   * The agent loop for this run, frozen on the run row (ADR-0044 decision 1). Absent means the
   * Claude Agent SDK, which is what every run was before the knob existed.
   */
  runtime?: "claude-agent-sdk" | "openai-agents";
  /** Deployment configuration relayed from .env. Never a literal in code. */
  model: string;
  cheapModel: string;
  /**
   * `FALLBACK_MODEL` from the Gateway's configuration, frozen on the run row (ADR-0023 decision
   * 3). The sidecar passes it verbatim as the SDK's `options.fallbackModel`; absent means none,
   * and the SDK then has no fallback. The SDK is the only retry owner.
   */
  fallbackModel?: string;
  /**
   * Reasoning overrides resolved by the Gateway (run config, else bot, else nothing). A key is
   * present only when something was set; the sidecar passes nothing to the SDK otherwise, so
   * the SDK's own default stays in force and the run row says `sdk-default`.
   */
  effort?: EffortLevel;
  thinking?: ThinkingConfig;
  /**
   * Model access: base URL plus a short-lived Bearer token. Opaque to the sidecar.
   * `modelBaseUrl` is the Gateway's model proxy, which validates the token and forwards upstream.
   * The same token authenticates the sidecar's own calls back to `gatewayBaseUrl`.
   */
  modelBaseUrl: string;
  modelAuthToken: string;
  /** Where the sidecar posts SidecarToGateway messages: `POST {gatewayBaseUrl}/internal/runs/{runId}/...`. */
  gatewayBaseUrl: string;
  shortWaitSeconds: number;
  /** Opt-in ADR-0007 prototype. Queue waiting consumes the existing run deadline. */
  browserCoordination?: { mode: "origin-v2"; deadlineAt: string };
  /** Experimental page-read policy. Absent is the established explicit-v1 behavior. */
  browserSnapshotMode?: BrowserSnapshotMode;
  /** ADR-0023 amendment 5: from the run row; absent keeps the CLI surface as it always was. */
  cliSurface?: CliSurface;
  /** Shared Chromium, fixed full-desktop region for this bot (ADR-0008). */
  screenSlot?: number;
  /** Opt-in strategy: automatic vision guidance and reviewed CLI workflows. */
  browserExecutionMode?: "vision-cli-v2";
  /**
   * ADR-0002 amendment 5 (proposed, opt-in): tier browser code by its effects. Absent is
   * `name-v1`, the tiers of every earlier run. Frozen on the run row.
   */
  browserCodeApproval?: "effects-v1";
  /**
   * ADR-0002 amendment 3, A5: the workspace operator's tier overrides, tool name to tier, frozen
   * on the run row at the first start. Absent (the default) is no override: every tool keeps the
   * curated table's tier, and the request is exactly the one sent before overrides existed.
   */
  toolTierOverrides?: Record<string, RiskLevel>;
  /**
   * ADR-0023 amendment 2: the run's model cannot see images (or was observed inventing what it
   * saw), so the sidecar replaces image content with a text notice. Absent means images are
   * delivered as before. Frozen on the run row; a resume gets the first attempt's value.
   */
  visionPolicy?: "withhold";
  /**
   * ADR-0048 decision 1: the run's bot and workspace have the opt-in native desktop tools, as
   * frozen on the run row. Absent means no `desktop` MCP server, the tools of every earlier run.
   */
  desktopTools?: "lcu-v1";
  /**
   * Set by the Gateway for a run in a `chat` thread with more than one member under `owner-v1`
   * (ADR-0005 amendment 2, decision 13): the sidecar adds the group norm to its guidance. The
   * sidecar does not decide this from the trigger, so a resumed process gets the same prompt.
   */
  groupGuidance?: "owner-v1";
  /**
   * Present for a `per-bot` run, the mode recorded on the run row (`runs.config_json.botWorkdir`,
   * ADR-0038 decision 1); absent keeps the shared `/work` and the prompt of every earlier run.
   */
  workdirMode?: "per-bot";
  /**
   * ADR-0036 decision 6: the same bot's live run on its other lane when this process started.
   * Sent only when the run froze `laneNotice` on and such a run exists; a note, never a lock.
   */
  otherLaneRun?: OtherLaneRun;
  /**
   * SDK `maxTurns` for this run, frozen in `runs.config_json` when attempt 1 starts: the
   * workspace setting, else `DESKMATES_MAX_TURNS` (ADR-0016 amendment 2). `null` is the workspace's
   * `off`: the SDK option is omitted and there is no turn warning.
   */
  maxTurns: number | null;
  /** Gateway-owned authoritative instruction file snapshots. Absent for legacy bots until import. */
  canonicalFiles?: {
    soul?: { body: string; version: string };
    memory?: { body: string; version: string };
  };
  /** Other bots' shared rule files to audit for mutations during this attempt. */
  peerBotHomeDirs?: readonly string[];
  /**
   * The workspace's egress allowlist at run start, checked in the PreToolUse hook. Deny by
   * default. The hook refreshes it from `GET /internal/runs/:runId/egress` before each navigation
   * check, so an operator edit reaches a running run on its next call; this copy is the fallback
   * when the Gateway cannot be reached.
   */
  egressAllowlist: readonly string[];
  /**
   * Connector names from the bot definition; the five connector tools accept only these. Names,
   * never a URL or a credential: the Gateway is the only caller of a connector (ADR-0012 item 2).
   */
  connectors: readonly string[];
  /**
   * How many live integration connections the run's workspace has (ADR-0013 item 5). The five
   * integration tools are offered only when this is above zero and `tools` lists them. A count,
   * never a runtime URL, token or connection secret (item 4). Absent means zero.
   */
  integrationConnections?: number;
  /**
   * Tools the sidecar exposes for this trigger; `thread_post` and `approval_decide` only when
   * there is a thread (ADR-0002 amendment 2: any member of the thread may decide).
   */
  tools: readonly SidecarToolName[];
  /**
   * The pinned memory index for this run (ADR-0011 decision 9), assembled by the Gateway from
   * trusted entries of this workspace, this bot and this thread. Rendered into the first user
   * turn, never into the system prompt. Absent on an approval resume and on older Gateways.
   */
  memoryIndex?: PinnedMemoryIndex;
  /**
   * The resumed SDK session already carries untrusted content from an earlier run or attempt, so
   * this process starts tainted (ADR-0011 decision 3). Recorded per session by the Gateway.
   */
  sessionTainted?: boolean;
  /** Sticky host-observed reasons that suppress learned items across a parked SDK session. */
  sessionDoNotLearnReasons?: readonly DoNotLearnReason[];
  /**
   * Open tasks linked to this run or its thread (ADR-0021 amendment 2). `task_deliver` is offered
   * only when there is at least one; the tool names them so the bot knows which ids it may deliver.
   * The Gateway re-checks the link on every delivery.
   */
  deliverableTasks?: readonly DeliverableTask[];
  /**
   * The run's skill set (ADR-0015 decision 1): exactly these skills, at these versions, are
   * written into the run's local plugin and listed in the SDK's `skills` option. Absent means
   * none. Files in `/home/<bot>/skills` are never read.
   */
  skills?: readonly RunSkill[];
}

export type SidecarToolName =
  | "thread_post"
  | "message_bot"
  | "approval_decide"
  | "knowledge_search"
  | "knowledge_read"
  | "knowledge_propose"
  | "tty_session"
  | "browser_cli_workflow"
  | "memory_search"
  | "task_deliver"
  | "app_publish"
  // ADR-0040: offered only where the installation configures the service.
  | "image_describe"
  | "audio_transcribe"
  // ADR-0040 amendment B: text-to-image, offered only where the installation configures it.
  | "image_generate"
  // ADR-0050: offered only to a run that froze `runStats: "self-v1"`.
  | "run_stats"
  // ADR-0049: offered only where the installation configures search and the workspace turned it on.
  | "web_search"
  | ConnectorToolName
  | IntegrationToolName
  // ADR-0045: offered only where the workspace has a usable Vault entry.
  | VaultToolName
  // ADR-0051: offered only to a run that froze `workspaceAssistant: "assistant-v1"`.
  | DefaultBotToolName;

/** Sidecar → Gateway: one ledger event, pushed as it happens. */
export interface SidecarEvent {
  type: "event";
  runId: RunId;
  /** `StartRunRequest.attempt`, echoed so a resumed process's events are not taken for redeliveries. */
  attempt: number;
  seq: number;
  kind: RunEventKind;
  payload: Record<string, unknown>;
  ts: string;
}

/** Sidecar → Gateway: the PreToolUse hook met an L2 call; the Gateway relays the human's decision (ADR-0002 amendment 1). */
export interface ApprovalRequest {
  type: "approval_request";
  runId: RunId;
  approvalId: ApprovalId;
  action: ToolAction;
  riskLevel: RiskLevel;
  /** `egress` for a first visit to a host outside the allowlist (ADR-0020); absent means a tool call. */
  kind?: "egress";
  /** SDK tool-use id of the call, so a later decision resumes that call and no other. */
  toolUseId?: string;
  /**
   * ADR-0029 decision 5: the call has the stable dimensions of an L2 call a restart interrupted
   * with an unknown outcome. The Gateway checks its own record and asks a human even when an
   * Always rule matches; the flag only lets the card name the interruption.
   */
  afterInterruption?: true;
}

/** Gateway → sidecar: the decision for a pending approval, or a timeout instruction. */
export interface ApprovalResponse {
  type: "approval_response";
  approvalId: ApprovalId;
  decision: HookDecision;
  reason?: string;
  /**
   * ADR-0029 decision 2: a `defer` because the Gateway is draining, not because of the approval,
   * which stays pending. The hook ends its live wait and the run parks as `waiting_platform`.
   */
  platform?: "drain";
}

/**
 * Gateway → sidecar: the answer to an event batch (`POST /internal/runs/:runId/events`). `drain`
 * tells the run to park at its next safe point (ADR-0029 decision 2); the sidecar already posts
 * batches continuously, so this needs no poll of its own.
 */
export interface SidecarEventsAck {
  stored: number;
  drain?: true;
}

/**
 * Sidecar → Gateway: the bot called `approval_decide` on a pending approval in a thread it is a
 * member of (ADR-0002 amendment 2, A2). The Gateway checks membership and records the bot.
 */
export interface ApprovalDecideRequest {
  type: "approval_decide";
  runId: RunId;
  approvalId: ApprovalId;
  decision: ApprovalDecision;
  reason?: string;
}

/** Sidecar → Gateway: acquire or release the workspace browser lock for a tab. */
export interface BrowserLockRequest {
  type: "browser_lock";
  runId: RunId;
  op: "acquire" | "renew" | "release";
  tabId?: string;
}

export interface BrowserLockResponse {
  type: "browser_lock_result";
  runId: RunId;
  granted: boolean;
  /** Increments on every human takeover; fences captures even after a quick handback. */
  epoch?: number;
  /** Present when a human holds the browser or another run owns the requested tab. */
  waitMessage?: string;
}

/** Host-owned origin scheduling, not an inter-bot permission boundary (ADR-0007). */
export interface BrowserOriginRequest {
  type: "browser_origin";
  runId: RunId;
  op: "acquire" | "renew" | "release";
  origin?: string;
}

export interface BrowserOriginResponse {
  type: "browser_origin_result";
  runId: RunId;
  granted: boolean;
  origin?: string;
  waitReason?: "origin_busy" | "human" | "lease_lost";
  retryAfterMs?: number;
}

/** Sidecar → Gateway: the bot called thread_post or message_bot. The Gateway routes it. */
export interface PostMessageRequest {
  type: "post_message";
  runId: RunId;
  tool: "thread_post" | "message_bot";
  /** Stable across HTTP retries of this single post; a new tool invocation gets a new ID. */
  requestId?: string;
  /** Target bot name for message_bot; ignored for thread_post. */
  to?: string;
  body: string;
  attachments: readonly { name: string; mimeType: string; ref: string }[];
}

/**
 * Sidecar → Gateway (`POST /internal/runs/:runId/session`): the SDK reported the session this
 * attempt runs on. Kept off the ledger, which carries only a fingerprint of it; the Gateway stores
 * it on the run row so a restart can resume the session of a run that never reported its end
 * (ADR-0029 decision 4).
 */
export interface SessionStartedReport {
  type: "session_started";
  runId: RunId;
  attempt: number;
  sdkSessionId: string;
}

/** Sidecar → Gateway: the process is ending. `deferred` means the run should park. */
export interface RunEnded {
  type: "run_ended";
  runId: RunId;
  outcome: "completed" | "deferred" | "failed" | "turns_exhausted";
  /** Host-authored partial handoff file when the attempt reached maxTurns. */
  handoffPath?: string;
  sdkSessionId?: string;
  summary?: RunSummary;
  usage: readonly Omit<RunUsage, "runId" | "costUsd">[];
  error?: string;
  /** Approval the run is parked on when outcome is `deferred`. */
  pendingApprovalId?: ApprovalId;
  /**
   * Every approval this process deferred, in order, `pendingApprovalId` (the last) included
   * (issue #62 M8). The OpenAI runtime gates the calls of one turn in parallel, so one process
   * can park on more than one; the Gateway marks each as waiting in the parked state.
   */
  pendingApprovalIds?: ApprovalId[];
  /** SDK tool-use id of the deferred call; sent back with the `approval` trigger on resume. */
  pendingToolUseId?: string;
  /** Origin of the last allowed navigation when the run parked; the resume starts from it. */
  currentOrigin?: string;
  /**
   * ADR-0029 decision 2: with outcome `deferred`, the platform (a drain), not an approval,
   * deferred the call. `pendingApprovalId` is then set only when the drain ended a live approval
   * wait; that approval stays pending.
   */
  platformInterruption?: PlatformInterruption;
  /**
   * ADR-0029 decision 10: the attempt was asked to resume a session and the SDK could not read
   * it, before any model turn. The Gateway continues on a fresh session with a handoff.
   */
  resumeFailed?: true;
  /**
   * Hex sha256 of the system prompt this process passed to the SDK; the Gateway merges it into
   * `runs.config_json` (M3 context plan, Phase 1). Absent when context assembly failed.
   */
  systemPromptSha256?: string;
  /**
   * Hex sha256 of the part of that prompt before the SDK's dynamic boundary (ADR-0023 amendment
   * 5); merged into `runs.config_json` like `systemPromptSha256`.
   */
  systemPromptStaticSha256?: string;
  /**
   * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` as the SDK's CLI subprocess received it, when it did; a knob
   * the Gateway records in `runs.config_json`.
   */
  maxContextTokens?: number;
  /**
   * The run's taint as the sidecar tracked it (ADR-0011 decision 3): how many model responses the
   * process saw and the first one whose input held untrusted content. The Gateway keeps it per
   * SDK session so a later resume starts tainted.
   */
  taint?: RunTaint;
}

export interface RunTaint {
  turns: number;
  doNotLearnReasons?: readonly DoNotLearnReason[];
  /** Absent when no untrusted content entered this process's context. */
  taintedAtTurn?: number;
  sourceKind?: MemorySourceKind;
}

export type SidecarToGateway =
  | SidecarEvent
  | ApprovalRequest
  | ApprovalDecideRequest
  | BrowserLockRequest
  | BrowserOriginRequest
  | PostMessageRequest
  | RunEnded;

/** Gateway → sidecar: the workspace's current egress allowlist (`GET /internal/runs/:runId/egress`). */
export interface EgressAllowlistResponse {
  type: "egress_allowlist";
  egressAllowlist: readonly string[];
  /**
   * The workspace's unexpired network-profile grants (ADR-0027 amendment 1). Absent from an
   * older Gateway; the hook then admits no LAN target.
   */
  grants?: readonly NetworkGrant[];
  /** When the list last changed, so a hook can log that it applied a newer list than it started with. */
  updatedAt: string;
}

export type GatewayToSidecar =
  | ApprovalResponse
  | BrowserLockResponse
  | BrowserOriginResponse
  | EgressAllowlistResponse;

/** Text browser tools return while a human holds the lock (design v0.3 §3.3). */
export const HUMAN_HOLDS_BROWSER_MESSAGE =
  "A human is operating the browser. Wait and retry after they hand back.";
