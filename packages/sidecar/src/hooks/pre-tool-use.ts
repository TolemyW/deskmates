// The PreToolUse hook: the sidecar's single interception point before a tool runs
// (ADR-0002 decisions 1 and 2; design v0.3 §5 step 4). In order:
//   a. redaction of the tool input for the ledger copy (every payload passes through the
//      EventSink's redactor) and of the `ToolAction` an approval request carries (the same
//      redactor, `ctx.redact`), so the raw input never leaves the process by either exit,
//   a'. the bot-directory guard (ADR-0038): a write into another bot's directory (per-bot mode) or
//      into /work/uploads -> deny with where to write instead. A soft guard, not a boundary,
//   b. egress allowlist for navigation tools -> deny. The list is refreshed from the Gateway
//      before every navigation check, so an operator's edit reaches a run already in flight; when
//      the Gateway cannot answer, the last list the hook used applies,
//   c. workspace browser lock for browser tools -> deny with the wait message when a human holds it,
//   d. risk tier: L0/L1 -> allow; L2 -> approval. `connector_submit` is tiered by the effect
//      class of the Gateway's stored validation, fetched here, never by its input (ADR-0012);
//      `integration_execute` by the catalog's operationType of its action, likewise (ADR-0013).
//
// A browser tool that reaches the L2 wait keeps its lock: the wait renews the workspace browser
// lock on every poll, because the lock TTL is shorter than the short wait.
//
// L2 and the SDK's control flow. The SDK runs this hook once, before `canUseTool`, and only the
// hook can return `permissionDecision: "defer"` (`PermissionResult` from `canUseTool` is
// allow | deny only, sdk.d.ts 0.3.278). So the short wait happens here: the hook posts the
// approval request, polls for up to `shortWaitSeconds`, and returns allow, deny, or defer
// (ADR-0002 amendment 1). On a resumed run the SDK replays the deferred call through this hook,
// which consumes the human's decision from the `approval` trigger for that call, matched by
// tool-use id. A resumed run is a new process and a new browser MCP session, so the replayed call
// carries a `ref` from a snapshot that no longer exists and usually fails; when its result is an
// error the decision is re-armed and the first later call in this process whose stable dimensions
// `(toolName, targetOrigin, argumentPattern)` equal the deferred action's consumes it instead
// (`consumedBy: retry`). Either way the decision is spent after one use, a call with different
// dimensions is judged afresh, and nothing survives the process (ADR-0002 amendment 2).
// `canUseTool` (can-use-tool.ts) is the fail-closed backstop for anything that reaches it without
// a hook decision.

import { randomUUID } from "node:crypto";
import type { HookCallback, HookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import {
  type ApprovalDecision,
  type ApprovalId,
  type ApprovalRequest,
  type DeferredAction,
  type DoNotLearnReason,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type IntegrationActionTier,
  type NetworkGrant,
  type RiskLevel,
  type StartRunRequest,
  type StoredConnectorValidation,
  type ToolAction,
  botWorkDir,
  egressAllows,
  isDeskmatesError,
  isPublicHostname,
  networkGrantAllowsUrl,
  riskForEffect,
  tierForAction,
} from "@deskmates/contracts";
import { waitForApproval } from "../approval-wait.js";
import { botDirectoryRefusal } from "../bot-directory-guard.js";
import type { BrowserState } from "../browser-state.js";
import type { GatewayClient } from "../gateway-client.js";
import { integrationApprovalPreview } from "../integration-approval-preview.js";
import type { EventSink } from "../ledger.js";
import {
  WORK_DIR,
  classifyTool,
  isBrowserTool,
  isConnectorSubmit,
  isIntegrationExecute,
  isNavigation,
  isShellTool,
} from "../risk-tier.js";
import type { PendingDecision, RunState } from "../run-state.js";
import { skillOfToolInput } from "../skill-plugin.js";
import {
  isShellFetch,
  shellUrls,
  targetHost,
  targetOrigin,
  targetUrl,
  toToolAction,
} from "../tool-action.js";
import {
  imageReadNotice,
  isImagePath,
  isPdfPath,
  offersLook,
  pdfReadNotice,
  withholdsImages,
} from "../vision-withhold.js";

/** Display-only facts the hook adds to a posted action (ADR-0002 amendment 3, A5). */
type ActionLabels = Pick<ToolAction, "agentType" | "unclassified">;

export interface HookContext {
  request: StartRunRequest;
  readBrowserState?: () => Promise<BrowserState | undefined>;
  client: GatewayClient;
  sink: EventSink;
  state: RunState;
  /**
   * The workspace egress allowlist the run started with (`StartRunRequest.egressAllowlist`). It is
   * the fallback, not the truth: the hook asks the Gateway for the current list before every
   * navigation check and keeps whatever it last got.
   */
  egressAllowlist: readonly string[];
  /**
   * The directory the run started in, which relative paths resolve against for the
   * bot-directory guard (ADR-0038). Absent means the mode's default directory.
   */
  cwd?: string;
  /**
   * The redactor the ledger sink uses, applied to the `ToolAction` before it is posted. The
   * approval request is the process's second exit: the Gateway stores the action in the approvals
   * row, the thread's system message and the `posted` event, so an unredacted `Authorization:
   * Bearer …` in an L2 shell command would land in a human-readable transcript.
   */
  redact: (value: unknown) => unknown;
  protectToolInput?: (toolName: string, input: Record<string, unknown>) => void;
  onDoNotLearn?: (reason: DoNotLearnReason) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  /** Poll interval for the approval wait; tests shorten it. */
  approvalPollMs?: number;
}

/** The SDK's built-in tool that loads an enabled skill's instructions. */
const SKILL_TOOL = "Skill";
/** The SDK's built-in file reader; it returns an image block for an image file. */
const READ_TOOL = "Read";

function allow(): HookJSONOutput {
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } };
}

/** Whether a hook output lets the call proceed (an egress ask that was allowed). */
function isAllow(output: HookJSONOutput): boolean {
  const specific = (output as { hookSpecificOutput?: { permissionDecision?: string } })
    .hookSpecificOutput;
  return specific?.permissionDecision === "allow";
}

function deny(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function defer(reason: string): HookJSONOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "defer",
      permissionDecisionReason: reason,
    },
  };
}

/** Turn a human's decision into the hook's answer; the same for a replay and for its retry. */
function applyDecision(
  approvalId: ApprovalId,
  decision: ApprovalDecision,
  reason?: string,
): HookJSONOutput {
  const allowed = decision === "allow_once" || decision === "allow_always";
  return allowed ? allow() : deny(reason ?? `Denied by human (approval ${approvalId})`);
}

/**
 * Whether a call is the action the human decided on. Only the dimensions that survive a new
 * process and a new page snapshot count; `undefined` matches `undefined` and nothing else, so a
 * click whose origin is unknown never inherits a decision given for a known one.
 */
function sameAction(action: ToolAction, deferred: DeferredAction): boolean {
  return (
    action.toolName === deferred.toolName &&
    action.targetOrigin === deferred.targetOrigin &&
    action.argumentPattern === deferred.argumentPattern
  );
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

export function createPreToolUseHook(ctx: HookContext): HookCallback {
  const { request, client, sink, state } = ctx;
  // ADR-0002 amendment 5: the run's frozen browser-code tier policy; absent is `name-v1`.
  const tierOptions = { browserCode: request.browserCodeApproval };

  /**
   * The workspace's egress allowlist as this hook last saw it. It starts as the copy the run was
   * started with and is replaced by every successful refresh, so an operator's edit reaches a run
   * already in flight on its next navigation instead of at its next restart.
   */
  let allowlist: readonly string[] = ctx.egressAllowlist;
  /**
   * The workspace's network-profile grants from the same refresh (ADR-0027 amendment 1
   * decision 10). Unlike the allowlist there is no start-time copy: a failed refresh means none.
   */
  let grants: readonly NetworkGrant[] = [];
  /** The last refresh failure reported, so a Gateway that stays down logs once, not per call. */
  let lastRefreshError: string | undefined;

  /**
   * Ask the Gateway for the current list before a navigation is judged. A failure is not a wider
   * list and not a denial of everything: it is the last list an operator published, which keeps
   * the check deny-by-default either way (design v0.3 §3.10).
   */
  async function refreshAllowlist(): Promise<readonly string[]> {
    try {
      const res = await client.getEgressAllowlist();
      const next = res.egressAllowlist;
      const added = next.filter((host) => !allowlist.includes(host));
      const removed = allowlist.filter((host) => !next.includes(host));
      if (added.length > 0 || removed.length > 0) {
        sink.emit("log", {
          source: "egress",
          op: "allowlist_refreshed",
          updatedAt: res.updatedAt,
          added,
          removed,
        });
      }
      allowlist = [...next];
      grants = res.grants ?? [];
      lastRefreshError = undefined;
    } catch (err) {
      grants = [];
      const error = String(err);
      if (error !== lastRefreshError) {
        lastRefreshError = error;
        sink.emit("log", { source: "egress", level: "warn", error });
      }
    }
    return allowlist;
  }

  /**
   * Keep the workspace browser lock alive while a browser call waits for a human. The lock TTL is
   * shorter than the short wait, so a lock taken before the wait would lapse mid-approval and
   * another bot could take the screen out from under the call being approved.
   */
  function renewBrowserLock(): Promise<void> {
    return client
      .browserLock({ type: "browser_lock", runId: request.runId, op: "renew" })
      .then(() => undefined);
  }

  async function decideL2(
    toolName: string,
    input: Record<string, unknown>,
    riskLevel: RiskLevel,
    toolUseId: string,
    decided: PendingDecision | undefined,
    holdsBrowserLock: boolean,
    signal: AbortSignal | undefined,
    actionOverride?: ToolAction,
    kind?: "egress",
    labels: ActionLabels = {},
  ): Promise<HookJSONOutput> {
    // The labels are display only (ADR-0002 amendment 3, A5): they ride on the posted action and
    // the ledger event, and never enter a rule's dimensions.
    const action: ToolAction = {
      ...(actionOverride ??
        toToolAction(toolName, input, { currentOrigin: state.currentOrigin, ...tierOptions })),
      ...labels,
    };

    // Resume: the replayed call, matched by tool-use id, consumes the human's decision. It is
    // remembered until its tool result arrives: an error there hands it on to the retry.
    if (decided) {
      if (decided.decision === "deny") ctx.onDoNotLearn?.("approval_denied");
      state.consumedDecision = {
        approvalId: decided.approvalId,
        decision: decided.decision,
        deferredAction: decided.deferredAction,
        reason: decided.reason,
        toolUseId,
      };
      sink.emit("approval", {
        phase: "resumed",
        consumedBy: "replay",
        approvalId: decided.approvalId,
        toolUseId,
        toolName,
        riskLevel,
        decision: decided.decision,
      });
      return applyDecision(decided.approvalId, decided.decision, decided.reason);
    }

    // The replayed call failed, most often on a `ref` from the old process's snapshot. The first
    // later call that is the same action takes the decision the human already gave; a call with
    // any other dimension is judged afresh (ADR-0002 amendment 2).
    const retry = state.retryDecision;
    if (retry !== undefined && sameAction(action, retry.deferredAction)) {
      if (retry.decision === "deny") ctx.onDoNotLearn?.("approval_denied");
      state.retryDecision = undefined;
      sink.emit("approval", {
        phase: "resumed",
        consumedBy: "retry",
        approvalId: retry.approvalId,
        toolUseId,
        replayedToolUseId: retry.replayedToolUseId,
        toolName,
        riskLevel,
        decision: retry.decision,
      });
      return applyDecision(retry.approvalId, retry.decision, retry.reason);
    }

    const approvalId = randomUUID() as ApprovalId;
    const req: ApprovalRequest = {
      type: "approval_request",
      runId: request.runId,
      approvalId,
      // The tier and the rule dimensions above were computed from the raw input; only what leaves
      // the process is redacted.
      action: ctx.redact(action) as ToolAction,
      riskLevel,
      toolUseId,
      ...(kind === undefined ? {} : { kind }),
    };
    sink.emit("approval", {
      phase: "requested",
      approvalId,
      toolUseId,
      toolName,
      riskLevel,
      input,
      ...labels,
    });

    const outcome = await waitForApproval(req, {
      client,
      now: ctx.now,
      sleep: ctx.sleep,
      shortWaitMs: request.shortWaitSeconds * 1000,
      ...(ctx.approvalPollMs === undefined ? {} : { pollMs: ctx.approvalPollMs }),
      ...(holdsBrowserLock ? { onPoll: renewBrowserLock } : {}),
      ...(signal === undefined ? {} : { signal }),
      onPollError: (err) =>
        sink.emit("log", {
          source: "approval_wait",
          approvalId,
          toolUseId,
          toolName,
          level: "warn",
          error: String(err),
        }),
    });

    // The Gateway never took the request, so no human can answer it: fail closed rather than let
    // the error escape into `canUseTool` (which also denies, but without a reason anyone can read).
    if (outcome.kind === "error") {
      ctx.onDoNotLearn?.("transport_error");
      const reason = `approval_unavailable: the Gateway did not accept approval ${approvalId} (${String(outcome.error)})`;
      sink.emit("approval", { phase: "failed", approvalId, toolUseId, toolName, reason });
      return deny(reason);
    }

    if (outcome.kind === "timeout") {
      ctx.onDoNotLearn?.("approval_timeout");
      state.deferredApprovalId = approvalId;
      state.deferredToolUseId = toolUseId;
      sink.emit("approval", {
        phase: "deferred",
        approvalId,
        toolUseId,
        toolName,
        reason: "short wait elapsed",
      });
      return defer(`Waiting for human approval (${approvalId})`);
    }
    const { decision, reason } = outcome.response;
    sink.emit("approval", { phase: "decided", approvalId, toolUseId, toolName, decision, reason });
    if (decision === "allow") return allow();
    if (decision === "deny") {
      ctx.onDoNotLearn?.("approval_denied");
      return deny(reason ?? `Denied by human (approval ${approvalId})`);
    }
    ctx.onDoNotLearn?.("approval_deferred");
    state.deferredApprovalId = approvalId;
    state.deferredToolUseId = toolUseId;
    return defer(reason ?? `Waiting for human approval (${approvalId})`);
  }

  /**
   * ADR-0012 item 6. The effect class comes from the Gateway's stored validation, never from the
   * tool input: `read` is L0, `reversible` L1, `external` L2. When the validation cannot be read
   * the call is denied, since its tier is unknown. The approval request names the connector id,
   * the validated content hash, the effect and the connector's summary, never a submission body;
   * `argumentPattern` keeps connector id and effect class, which is what an Always rule stores.
   */
  async function decideConnectorSubmit(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    decided: PendingDecision | undefined,
    signal: AbortSignal | undefined,
    labels: ActionLabels,
  ): Promise<HookJSONOutput> {
    const connector = typeof input.connector === "string" ? input.connector : "";
    const validationId = typeof input.validationId === "string" ? input.validationId : "";
    let validation: StoredConnectorValidation;
    try {
      if (connector === "" || validationId === "")
        throw new Error("connector and validationId are required");
      validation = await client.connectorValidation(connector, validationId);
    } catch (err) {
      const code = isDeskmatesError(err) ? err.code : "unavailable";
      const reason = `connector_submit refused before execution: the validation could not be read (${code})`;
      sink.emit("log", { source: "pre_tool_use", toolUseId, toolName, decision: "deny", reason });
      return deny(reason);
    }
    const riskLevel = riskForEffect(validation.effect);
    sink.emit("log", {
      source: "pre_tool_use",
      toolUseId,
      toolName,
      op: "connector_tier",
      connectorId: validation.connectorId,
      validationId,
      effect: validation.effect,
      riskLevel,
    });
    if (riskLevel !== "L2") return allow();
    const dimensions = `connector:${validation.connectorId} effect:${validation.effect}`;
    const action: ToolAction = {
      toolName,
      input: {
        connector,
        connectorId: validation.connectorId,
        validationId,
        contentHash: validation.contentHash,
        effect: validation.effect,
        summary: validation.summary,
      },
      argumentSummary: `${dimensions} hash:${validation.contentHash}`,
      argumentPattern: `${dimensions} *`,
    };
    return decideL2(
      toolName,
      input,
      riskLevel,
      toolUseId,
      decided,
      false,
      signal,
      action,
      undefined,
      labels,
    );
  }

  /**
   * ADR-0013 item 6. The tier comes from the catalog's `operationType` and the operator's
   * override, read from the Gateway, never from the tool input: read is L0, write L2 unless
   * lowered to L1, destructive L2. When the Gateway cannot answer, the call is denied, since its
   * tier is unknown. The approval request names service, action, connection, operationType, the
   * catalog description and scopes, plus a redacted Drive proposal preview; an Always rule stores
   * `integration:<service> action:<id>`.
   */
  async function decideIntegrationExecute(
    toolName: string,
    input: Record<string, unknown>,
    toolUseId: string,
    decided: PendingDecision | undefined,
    signal: AbortSignal | undefined,
    labels: ActionLabels,
  ): Promise<HookJSONOutput> {
    const actionId = typeof input.actionId === "string" ? input.actionId : "";
    const connectionName =
      typeof input.connectionName === "string" && input.connectionName !== ""
        ? input.connectionName
        : undefined;
    let facts: IntegrationActionTier;
    try {
      if (actionId === "") throw new Error("actionId is required");
      facts = await client.integrationTier(actionId, connectionName);
      if (facts.actionId !== actionId || !actionId.startsWith(`${facts.service}.`))
        throw new Error("catalog action identity mismatch");
    } catch (err) {
      const code = isDeskmatesError(err) ? err.code : "unavailable";
      const reason = `integration_execute refused before execution: the action's tier could not be read (${code})`;
      sink.emit("log", { source: "pre_tool_use", toolUseId, toolName, decision: "deny", reason });
      return deny(reason);
    }
    const riskLevel = tierForAction(facts.operationType, facts.override);
    sink.emit("log", {
      source: "pre_tool_use",
      toolUseId,
      toolName,
      op: "integration_tier",
      service: facts.service,
      actionId: facts.actionId,
      connectionName: facts.connectionName,
      operationType: facts.operationType,
      riskLevel,
    });
    if (riskLevel !== "L2") return allow();
    const dimensions = `integration:${facts.service} action:${facts.actionId}`;
    const preview = integrationApprovalPreview(actionId, input.input, [request.modelAuthToken]);
    const action: ToolAction = {
      toolName,
      input: {
        service: facts.service,
        actionId: facts.actionId,
        connectionName: facts.connectionName,
        operationType: facts.operationType,
        description: facts.description,
        requiredScopes: facts.requiredScopes,
        ...(preview ? { preview } : {}),
      },
      argumentSummary: dimensions,
      argumentPattern: dimensions,
    };
    return decideL2(
      toolName,
      input,
      riskLevel,
      toolUseId,
      decided,
      false,
      signal,
      action,
      undefined,
      labels,
    );
  }

  /**
   * On resume the SDK replays the deferred call through the hook before anything else, so the
   * first hook call settles the pending decision: it applies when the replayed call carries the
   * tool-use id the decision was given for, and is discarded otherwise. Either way it cannot
   * leak to a later call, even when the replayed one is stopped by egress or the browser lock.
   */
  function settlePendingDecision(toolUseId: string, toolName: string): PendingDecision | undefined {
    const pending = state.pendingDecision;
    if (pending === undefined) return undefined;
    state.pendingDecision = undefined;
    if (pending.toolUseId !== undefined && pending.toolUseId === toolUseId) return pending;
    sink.emit("approval", {
      phase: "discarded",
      approvalId: pending.approvalId,
      toolUseId,
      toolName,
      decision: pending.decision,
      reason:
        pending.toolUseId === undefined
          ? "the approval trigger named no tool call"
          : `the decision was for tool call ${pending.toolUseId}`,
    });
    return undefined;
  }

  // Every non-allow outcome is recorded on the run state: the call never reaches the MCP proxy,
  // so the run loop must not count it as a page-changing action (`screenshots.ts`).
  return async (hookInput, toolUseID, options) => {
    const output = await decide(hookInput, toolUseID, options);
    const decision = "hookSpecificOutput" in output ? output.hookSpecificOutput : undefined;
    // ADR-0015 decision 6: use is measured here, when the `Skill` tool is about to run, never
    // taken from the model's summary. The Gateway counts it only for a skill of the run's set.
    if (hookInput.hook_event_name === "PreToolUse" && hookInput.tool_name === SKILL_TOOL) {
      const skill = skillOfToolInput(asRecord(hookInput.tool_input));
      if (skill !== undefined && isAllow(output))
        sink.emit("skill_used", { skill, toolUseId: toolUseID ?? hookInput.tool_use_id });
    }
    if (
      hookInput.hook_event_name === "PreToolUse" &&
      decision !== undefined &&
      "permissionDecision" in decision &&
      decision.permissionDecision !== "allow"
    ) {
      state.deniedToolUseIds.add(toolUseID ?? hookInput.tool_use_id);
    }
    return output;
  };

  async function decide(
    hookInput: Parameters<HookCallback>[0],
    toolUseID: Parameters<HookCallback>[1],
    options: Parameters<HookCallback>[2],
  ): Promise<HookJSONOutput> {
    if (hookInput.hook_event_name !== "PreToolUse") return {};
    const toolName = hookInput.tool_name;
    const input = asRecord(hookInput.tool_input);
    ctx.protectToolInput?.(toolName, input);
    const toolUseId = toolUseID ?? hookInput.tool_use_id;
    const decided = settlePendingDecision(toolUseId, toolName);
    // A call made inside a subagent the run spawned: the SDK sets `agent_id` (A5).
    const subagent: ActionLabels =
      hookInput.agent_id === undefined
        ? {}
        : { agentType: hookInput.agent_type ?? "unknown subagent" };

    // ADR-0023 amendment 2, decision 12: on a model that cannot see, an image `Read` would be an
    // image block the model describes anyway. Deny it with a notice the model can read instead.
    if (toolName === READ_TOOL && withholdsImages(request) && isImagePath(input.file_path)) {
      sink.emit("log", {
        source: "vision",
        op: "image_withheld",
        toolName,
        toolUseId,
        path: input.file_path,
      });
      return deny(imageReadNotice(input.file_path, offersLook(request)));
    }
    // Amendment 3, decision 15: a PDF reaches the model as page images, so it is withheld too.
    if (toolName === READ_TOOL && withholdsImages(request) && isPdfPath(input.file_path)) {
      sink.emit("log", {
        source: "vision",
        op: "image_withheld",
        toolName,
        toolUseId,
        path: input.file_path,
        media: "application/pdf",
      });
      return deny(pdfReadNotice(input.file_path, offersLook(request)));
    }

    const command =
      typeof input.command === "string"
        ? input.command
        : toolName === "mcp__deskmates__tty_session" && typeof input.data === "string"
          ? input.data
          : "";

    // ADR-0038 decisions 2 to 4: another bot's directory (per-bot mode) and /work/uploads (every
    // mode) are read-only to this bot. A soft guard against mistakes, NOT a security boundary: it
    // reads the literal input only (see bot-directory-guard.ts for what it cannot see).
    const dirs = botDirectoryRefusal(
      toolName,
      input,
      command,
      isShellTool(toolName) || toolName === "mcp__deskmates__tty_session",
      {
        botName: request.botName,
        ...(request.workdirMode === "per-bot" ? { workdirMode: "per-bot" as const } : {}),
        cwd:
          ctx.cwd ?? (request.workdirMode === "per-bot" ? botWorkDir(request.botName) : WORK_DIR),
      },
    );
    if (dirs !== undefined) {
      sink.emit("log", {
        source: "bot_dirs",
        op: "write_refused",
        toolName,
        toolUseId,
        path: dirs.path,
        area: dirs.area,
        ...(dirs.owner === undefined ? {} : { owner: dirs.owner }),
      });
      return deny(dirs.message);
    }

    // A call that cannot reach the network never asks the Gateway anything: the refresh is one
    // round trip per navigation check, not one per tool call.
    const workflow = toolName === "mcp__deskmates__browser_cli_workflow";
    const navigation = isNavigation(toolName, input);
    const shellFetch = isShellTool(toolName) && isShellFetch(command);
    const egressAllowlist =
      navigation || shellFetch || workflow ? await refreshAllowlist() : ctx.egressAllowlist;

    if (workflow) {
      const urls: unknown[] = [input.expectedOrigin];
      if (!Array.isArray(input.steps) || input.steps.length === 0 || input.steps.length > 20)
        return deny("Invalid browser workflow steps");
      for (const step of input.steps) {
        if (step && typeof step === "object" && (step as Record<string, unknown>).action === "goto")
          urls.push((step as Record<string, unknown>).url);
      }
      for (const url of urls) {
        try {
          if (typeof url !== "string") throw new Error("missing URL");
          const parsed = new URL(url);
          if (
            !["http:", "https:"].includes(parsed.protocol) ||
            parsed.port ||
            parsed.username ||
            parsed.password ||
            !egressAllows(parsed.hostname, egressAllowlist)
          )
            throw new Error("blocked");
        } catch {
          ctx.onDoNotLearn?.("egress_block");
          return deny(
            "egress_blocked: browser workflow URLs must be allowlisted public HTTP/HTTPS on standard ports",
          );
        }
      }
    }

    // (b) egress (design v0.3 §3.10, ADR-0020): a host outside the allowlist is asked for when it
    // is a public hostname, as an egress approval whose "allow this site" grows the list; a
    // private address, an IP literal or an unreadable URL is denied outright. Any browser tool
    // that carries a url (`browser_tabs {action:"new", url}`) is navigation, not only
    // browser_navigate.
    const askEgress = async (host: string, url: string | undefined): Promise<HookJSONOutput> => {
      const action: ToolAction = {
        toolName,
        input,
        targetOrigin: `https://${host}`,
        argumentSummary: `open ${url ?? host}`,
        argumentPattern: host,
      };
      sink.emit("log", {
        source: "pre_tool_use",
        toolUseId,
        toolName,
        decision: "ask",
        reason: `egress_ask: ${host} is not in the workspace allowlist`,
      });
      return decideL2(
        toolName,
        input,
        "L2",
        toolUseId,
        decided,
        false,
        options?.signal,
        action,
        "egress",
        subagent,
      );
    };
    const blockEgress = (reason: string): HookJSONOutput => {
      ctx.onDoNotLearn?.("egress_block");
      sink.emit("log", { source: "pre_tool_use", toolUseId, toolName, decision: "deny", reason });
      return deny(reason);
    };
    if (navigation) {
      const host = targetHost(input);
      if (host === undefined) return blockEgress("egress_blocked: no valid URL");
      // A root-selected network profile admits its exact LAN origins, IP literals and custom
      // ports included; nothing else does, `*` neither (ADR-0027 amendment 1).
      const url = targetUrl(input);
      const granted = url !== undefined && networkGrantAllowsUrl(grants, url);
      if (!granted && !egressAllows(host, egressAllowlist)) {
        if (!isPublicHostname(host))
          return blockEgress(`egress_blocked: ${host} is not in the workspace allowlist`);
        const verdict = await askEgress(
          host,
          typeof input.url === "string" ? input.url : undefined,
        );
        if (!isAllow(verdict)) return verdict;
      }
      // The page the run is on from here: the origin a later click, type or upload happens
      // against, and the dimension an approval rule matches on (ADR-0002 amendment 2, A3). Only a
      // navigation that got past egress counts; a blocked one never opened its page.
      const origin = targetOrigin(input);
      if (origin !== undefined) state.currentOrigin = origin;
    }
    // (b') a shell command that curls or wgets is navigation too: every URL in it must be allowed,
    // and a command whose target cannot be read is denied rather than let through.
    if (shellFetch) {
      const urls = shellUrls(command);
      let blocked: string | undefined;
      if (urls.length === 0) blocked = "no readable URL";
      for (const u of urls) {
        if (networkGrantAllowsUrl(grants, u)) continue;
        let h: string | undefined;
        try {
          h = new URL(u).hostname.toLowerCase();
        } catch {
          h = undefined;
        }
        if (h === undefined) blocked = "an unreadable URL";
        else if (!egressAllows(h, egressAllowlist)) blocked = h;
        if (blocked !== undefined) break;
      }
      if (blocked !== undefined) {
        const reason = `egress_blocked: shell fetch to ${blocked} is not in the workspace allowlist`;
        if (
          blocked === "no readable URL" ||
          blocked === "an unreadable URL" ||
          !isPublicHostname(blocked)
        )
          return blockEgress(reason);
        const verdict = await askEgress(blocked, undefined);
        if (!isAllow(verdict)) return verdict;
      }
    }

    // (c) browser lock: acquire before every browser tool; a human holder means wait, no retry.
    let holdsBrowserLock = false;
    if (isBrowserTool(toolName)) {
      const browser = await ctx.readBrowserState?.();
      // Use metadata for approval dimensions, but do not move the lease here: SDK hooks may
      // run ahead of a browser action already in flight. The serialized proxy selects/leases
      // the actual target. Acquiring without a tab ID preserves the currently held lease.
      const tabId =
        toolName.endsWith("browser_tabs") && typeof input.index === "number"
          ? browser?.tabs[input.index]?.id
          : browser?.tabId;
      if (browser && !navigation) {
        const selected = browser.tabs.find((tab) => tab.id === tabId);
        state.currentOrigin = selected ? targetOrigin({ url: selected.url }) : undefined;
      }
      const lock = await client.browserLock({
        type: "browser_lock",
        runId: request.runId,
        op: "acquire",
      });
      if (!lock.granted) {
        ctx.onDoNotLearn?.("browser_wait");
        const message = lock.waitMessage ?? HUMAN_HOLDS_BROWSER_MESSAGE;
        sink.emit("takeover", { toolUseId, toolName, waitMessage: message });
        return deny(message);
      }
      holdsBrowserLock = true;
    }

    // (d') connector submit: tiered by the stored validation's effect class (ADR-0012 item 6).
    if (isConnectorSubmit(toolName))
      return decideConnectorSubmit(toolName, input, toolUseId, decided, options?.signal, subagent);

    // (d'') integration execute: tiered by the catalog's operationType (ADR-0013 item 6).
    if (isIntegrationExecute(toolName))
      return decideIntegrationExecute(
        toolName,
        input,
        toolUseId,
        decided,
        options?.signal,
        subagent,
      );

    // (d) risk tier. A tool in no table is L2 and labelled `unclassified` (ADR-0002 amendment 3, A5).
    const tier = classifyTool(toolName, input, tierOptions);
    if (tier.level !== "L2") return allow();
    return decideL2(
      toolName,
      input,
      tier.level,
      toolUseId,
      decided,
      holdsBrowserLock,
      options?.signal,
      undefined,
      undefined,
      { ...subagent, ...(tier.unclassified ? { unclassified: true as const } : {}) },
    );
  }
}
