// Messages between the Gateway and the sidecar inside the workspace container.
// The sidecar never decides who is woken and never sees the upstream model key.

import type { ApprovalDecision, HookDecision, RiskLevel, ToolAction } from "./approval.js";
import type { ConnectorToolName } from "./connector.js";
import type { ApprovalId, BotId, RunId, ThreadId, WorkspaceId } from "./ids.js";
import type { IntegrationToolName } from "./integration.js";
import type { DoNotLearnReason, MemorySourceKind, PinnedMemoryIndex } from "./memory.js";
import type { NetworkGrant } from "./network-profile.js";
import type { EffortLevel, ThinkingConfig } from "./reasoning.js";
import type { RunEventKind, RunSummary, RunUsage } from "./run.js";
import type { RunSkill } from "./skill.js";
import type { DeliverableTask } from "./task.js";
import type { ThreadMessageTrigger } from "./thread.js";

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
      /** Stable dimensions of the deferred action, from the approval row, for the retry match. */
      deferredAction?: DeferredAction;
      /**
       * Origin of the page the parked process had navigated to (`RunEnded.currentOrigin`), so the
       * resumed process derives `targetOrigin` for browser calls before it navigates again.
       */
      currentOrigin?: string;
    }
  | { kind: "continuation"; approvalId: ApprovalId; decision: "continue"; handoffPath?: string }
  /** An Admin continued work the workspace budget parked (ADR-0032 decision 7). */
  | { kind: "budget_continuation"; handoffPath?: string };

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

/** Gateway → sidecar supervisor: start one run as one sidecar process. */
export interface StartRunRequest {
  /** Tool-free, isolated presentation job (ADR-0027). */
  presentationSummary?: boolean;
  /** Which presentation job: an approval (ADR-0028, the default) or an Activity run (ADR-0033). */
  presentationKind?: "approval" | "activity";
  /** Tool-free, one-turn model job (ADR-0023 amendment 1); the trigger is not read. */
  modelJob?: ModelJobRequest;
  runId: RunId;
  botId: BotId;
  botName: string;
  workspaceId: WorkspaceId;
  threadId?: ThreadId;
  /** `/home/<bot>`; holds SOUL.md, MEMORY.md, diary, skills, .claude. */
  botHomeDir: string;
  /** Present on resume; the sidecar passes it to the SDK as `resume`. */
  sdkSessionId?: string;
  /**
   * Which sidecar process of this run this is: 1 for the first, one more on every resume. The
   * sidecar's event counter restarts at 1 in every process, so the Gateway dedups redelivered
   * events on `(run, attempt, seq)`, never on `(run, seq)` alone.
   */
  attempt: number;
  trigger: TriggerPayload;
  /**
   * The agent loop for this run, frozen on the run row (ADR-0042 decision 1). Absent means the
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
   * ADR-0023 amendment 2: the run's model cannot see images (or was observed inventing what it
   * saw), so the sidecar replaces image content with a text notice. Absent means images are
   * delivered as before. Frozen on the run row; a resume gets the first attempt's value.
   */
  visionPolicy?: "withhold";
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
  | ConnectorToolName
  | IntegrationToolName;

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
}

/** Gateway → sidecar: the decision for a pending approval, or a timeout instruction. */
export interface ApprovalResponse {
  type: "approval_response";
  approvalId: ApprovalId;
  decision: HookDecision;
  reason?: string;
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
  /** SDK tool-use id of the deferred call; sent back with the `approval` trigger on resume. */
  pendingToolUseId?: string;
  /** Origin of the last allowed navigation when the run parked; the resume starts from it. */
  currentOrigin?: string;
  /**
   * Hex sha256 of the system prompt this process passed to the SDK; the Gateway merges it into
   * `runs.config_json` (M3 context plan, Phase 1). Absent when context assembly failed.
   */
  systemPromptSha256?: string;
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
