import { createHash } from "node:crypto";
import { runModelJob } from "./model-job.js";
import { presentationSummary } from "./presentation-summary.js";
// One run, start to finish (design v0.3 §5 steps 3 to 7): assemble context, register MCP
// servers, call `query()` with the fixed SDK configuration (ADR-0002 decision 3), stream every
// message into ledger events, then report `RunEnded` with the structured summary and per-model
// token counts. The Gateway prices tokens; the SDK's `costUSD` is ignored (ADR-0002 decision 5).
//
// The SDK owns model retries and fallback (ADR-0023 decision 3): `FALLBACK_MODEL` from the
// Gateway reaches `options.fallbackModel` verbatim, every `api_retry` message becomes a
// `model_retry` event and the `PostModelSwitch` hook a `model_switch` event. The sidecar calls
// `query()` once and never retries a model call itself.
//
// The run also owns the screenshot half of the capture contract (`screenshots.ts`): it creates
// the run's capture directory before the query, pairs the nth page-changing browser call with
// the proxy's file n when that call's result arrives, emits the `screenshot` event, and removes
// the directory when the run is over.

import type {
  HookCallback,
  McpServerConfig,
  Options,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type ModelRetryPayload,
  type ModelSwitchPayload,
  type RunEnded,
  type RunSummary,
  type RunUsage,
  type StartRunRequest,
  botWorkDir,
  learnedFromSuggestions,
} from "@deskmates/contracts";
import { DEFAULT_CDP_ENDPOINT, browserMcpServer } from "./browser-mcp.js";
import { browserStatePath, parseBrowserState } from "./browser-state.js";
import { createCanUseTool } from "./can-use-tool.js";
import {
  type CanonicalFileSnapshot,
  auditCanonicalFiles,
  prepareCanonicalFiles,
  snapshotPeerRuleFiles,
} from "./canonical-files.js";
import { buildContext, diaryPath, knowledgeQuery } from "./context.js";
import type { SidecarDeps } from "./deps.js";
import { GatewayClient } from "./gateway-client.js";
import { createPreCompactHook } from "./hooks/pre-compact.js";
import { createPreToolUseHook } from "./hooks/pre-tool-use.js";
import { EventSink } from "./ledger.js";
import { managedProxyEnvironment } from "./managed-proxy.js";
import { TaintTracker } from "./memory-taint.js";
import { ModelSwitchRecorder, fallbackSwitch, isModelFallbackMessage } from "./model-switch.js";
import { redactText, redactValue } from "./redact.js";
import { ReplyPreviewer } from "./reply-preview.js";
import {
  BROWSER_MCP_SERVER,
  DESKMATES_MCP_SERVER,
  WORK_DIR,
  riskTier,
  splitMcpToolName,
} from "./risk-tier.js";
import { createRunState } from "./run-state.js";
import { SidecarTimeline, processStartedAt } from "./run-timeline.js";
import { screenshotRecorder } from "./screenshot-budget.js";
import {
  SCREENSHOT_MAX_PER_RUN,
  SCREENSHOT_WAIT_MS,
  type ScreenshotFile,
  isPageChangingBrowserTool,
  parseScreenshotFile,
  screenshotFileName,
} from "./screenshots.js";
import { carrySessionIntoBotDir } from "./session-carry.js";
import { materializeSkillPlugin, skillPluginDir } from "./skill-plugin.js";
import { parseRunSummary } from "./summary.js";
import { createThreadTools } from "./thread-tools.js";
import { ledgerToolResult } from "./tool-evidence.js";
import { toolResultText } from "./tool-result-text.js";
import { TtySessions } from "./tty-session.js";
import { TurnUsageTracker } from "./turn-usage.js";
import { TurnWarning } from "./turn-warning.js";
import { withholdsImages } from "./vision-withhold.js";

/** Seconds added to the short wait so the SDK does not time the hook out mid-wait. */
export const HOOK_TIMEOUT_MARGIN_SECONDS = 60;

/**
 * Built-in CLI tools the run never offers. Verified against the list the CLI sends the model
 * through the real stack (`spikes/list-cli-tools.ts`, SDK 0.3.278):
 *
 * - `WebSearch`, `WebFetch`: reach the network without a URL the hook could check against the
 *   egress allowlist (M0).
 * - `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode`, `Workflow`: need a person at a terminal.
 *   The SDK routes them through `canUseTool` in headless mode (that callback is how a human's
 *   answer or plan approval would arrive), so the fail-closed backstop denies them even after a
 *   human allowed the call in the hook; the bot's correct move is to ask in its reply and end
 *   the run. Seen in a real run: an `AskUserQuestion` approved by a human, then denied by
 *   `canUseTool`.
 * - `CronCreate`, `CronDelete`, `CronList`, `ScheduleWakeup`: schedule work in a CLI session
 *   that does not exist here; the Gateway is the scheduler (bot cron entries, design v0.3 §3.4).
 */
export const DISALLOWED_TOOLS: readonly string[] = [
  "WebSearch",
  "WebFetch",
  "AskUserQuestion",
  "EnterPlanMode",
  "ExitPlanMode",
  "Workflow",
  "CronCreate",
  "CronDelete",
  "CronList",
  "ScheduleWakeup",
];

/** How often the run process looks for the capture file of an action it has the result of. */
const SCREENSHOT_POLL_MS = 50;

/** Backoff between `run_ended` posts: five attempts spread over about 15 s. */
export const ENDED_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/** Prefix of the stdout line that carries `RunEnded` when the Gateway never took the post. */
export const RUN_ENDED_STDOUT_PREFIX = "RUN_ENDED ";

export interface RunOnceOptions {
  /** Poll interval for the approval short wait; tests shorten it. */
  approvalPollMs?: number;
  /** Ledger batch delay; tests shorten it. */
  batchDelayMs?: number;
  /**
   * Directory the MCP proxy writes its captures to and this process reads them from, one per run.
   * Defaults to `<TMPDIR>/deskmates-shots-<runId>`; `runOnce` creates it and removes it at the end.
   */
  screenshotDir?: string;
  /** Where the `RUN_ENDED ` fallback line goes; defaults to this process's stdout. */
  writeStdout?: (line: string) => void;
  /** Called when `RunEnded` could not be delivered at all; `main()` turns it into exit code 3. */
  onEndedUndeliverable?: (ended: RunEnded) => void;
}

export type RunUsageEntry = Omit<RunUsage, "runId" | "costUsd">;

/**
 * Environment variables the SDK's CLI subprocess may inherit from the container. An allowlist,
 * not a denylist: the container environment belongs to the whole workspace and holds whatever an
 * operator, an image layer or another process put there, and anything the CLI recognises changes
 * how the run behaves. `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_API_KEY` would give the run a
 * second, unmetered way to reach a model; `ANTHROPIC_MODEL` would silently swap the model the
 * Gateway chose and priced; `HTTPS_PROXY` would route every model call through a third party;
 * `NODE_OPTIONS` can load arbitrary code into the CLI process. None of them can be named here, so
 * none of them can be forwarded by accident when the next one is invented.
 */
const ENV_PASSTHROUGH = new Set([
  "PATH",
  "HOME",
  "LANG",
  "TZ",
  "DISPLAY",
  "TMPDIR",
  "TERM",
  "SHELL",
  "USER",
]);

/** Prefixes whose whole family passes: locale categories and this project's own settings. */
const ENV_PASSTHROUGH_PREFIXES = ["LC_", "DESKMATES_"];

function inheritedEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    if (ENV_PASSTHROUGH.has(k) || ENV_PASSTHROUGH_PREFIXES.some((p) => k.startsWith(p))) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * The allowlist comes from the Gateway with the run and is used exactly as sent, empty list
 * included. `DESKMATES_EGRESS_ALLOWLIST` (comma-separated) applies only when the request carries no
 * list at all, which means a hand run outside a Gateway. Merging the two, as this did, made the
 * container environment a second source of truth: a host an operator removed from the workspace
 * stayed reachable until someone recreated the container, and the agent could see why.
 */
export function resolveAllowlist(
  fromRequest: readonly string[] | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  if (fromRequest !== undefined) return [...fromRequest];
  return (env.DESKMATES_EGRESS_ALLOWLIST ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/**
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` from an environment, when it is a positive integer. The CLI
 * picks its compaction threshold from it for model ids it does not know (M3 context plan,
 * problem 3), so it is a knob `runs.config_json` records.
 */
export function maxContextTokensOf(
  env: Readonly<Record<string, string | undefined>>,
  key = "CLAUDE_CODE_MAX_CONTEXT_TOKENS",
): number | undefined {
  const raw = env[key]?.trim();
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** SDK file tools whose `file_path`/`notebook_path` a handoff lists as evidence (A3j). */
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/**
 * The host-authored handoff (ADR-0016, ADR-0021 A3j): Gateway identity, the last prose (or an
 * explicit line that there is none), files this attempt wrote, and the latest checkpoint per task.
 * Pointers only; it judges and completes nothing.
 */
export function handoffText(
  request: StartRunRequest,
  lastAssistantText: string,
  writtenPaths: readonly string[],
): string {
  const prose = lastAssistantText.trim();
  const lines = [
    "# Partial work handoff",
    "",
    `Run: ${request.runId}`,
    `Attempt: ${request.attempt}`,
    `Bot: ${request.botName}`,
    ...(request.deliverableTasks ?? []).map(
      (t) => `Task: ${t.id} "${t.title}"${t.scopeVersion ? ` (scope v${t.scopeVersion})` : ""}`,
    ),
    "",
    "## Last assistant text",
    prose === "" ? "No prose summary was produced in the last turn." : prose.slice(0, 12000),
    "",
    "## Files written or edited in this attempt",
    ...(writtenPaths.length > 0
      ? writtenPaths.slice(0, 200).map((p) => `- ${p}`)
      : ["None recorded through file tools."]),
  ];
  for (const task of request.deliverableTasks ?? []) {
    const cp = task.latestCheckpoint;
    if (!cp) continue;
    lines.push(
      "",
      `## Latest checkpoint for ${task.id} (run ${cp.runId ?? "unknown"}, attempt ${cp.attempt}, ${cp.createdAt})`,
      ...cp.completed.map(
        (u) =>
          `- completed: ${u.unit} (${u.outcome})${u.evidence.length ? `; evidence: ${u.evidence.join(", ")}` : "; evidence missing"}`,
      ),
      ...cp.outstanding.map((u) => `- outstanding: ${u}`),
    );
  }
  return `${lines.join("\n")}\n`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}… [+${text.length - max} chars]`;
}

/** `fetch` reports "fetch failed" and hides the socket error in `cause`; show both. */
function describeError(err: unknown): string {
  const cause =
    err instanceof Error && err.cause !== undefined ? ` (cause: ${String(err.cause)})` : "";
  return `${String(err)}${cause}`;
}

function usageFromResult(
  modelUsage: Record<
    string,
    {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    }
  >,
): RunUsageEntry[] {
  return Object.entries(modelUsage).map(([model, u]) => ({
    model,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadTokens: u.cacheReadInputTokens,
    cacheCreateTokens: u.cacheCreationInputTokens,
  }));
}

export async function runOnce(
  request: StartRunRequest,
  deps: SidecarDeps,
  opts: RunOnceOptions = {},
): Promise<RunEnded> {
  const secrets = [request.modelAuthToken];
  const browserToolUses = new Set<string>();
  function protectToolInput(toolName: string, input: Record<string, unknown>): void {
    if (
      toolName !== "mcp__deskmates__tty_session" ||
      input.sensitive !== true ||
      typeof input.data !== "string"
    )
      return;
    for (const value of [
      input.data,
      input.data.trimEnd(),
      JSON.stringify(input.data).slice(1, -1),
    ]) {
      if (value.length >= 4 && !secrets.includes(value)) secrets.push(value);
    }
  }
  const client = new GatewayClient(
    deps.fetch,
    request.gatewayBaseUrl,
    request.runId,
    request.modelAuthToken,
  );
  const sink = new EventSink({
    runId: request.runId,
    attempt: request.attempt,
    post: (batch) => client.postEvents(batch),
    redact: (payload) => redactValue(payload, secrets),
    now: deps.now,
    ...(opts.batchDelayMs === undefined ? {} : { batchDelayMs: opts.batchDelayMs }),
    sleep: deps.sleep,
    onError: (err) => process.stderr.write(`ledger post failed: ${describeError(err)}\n`),
  });
  // ADR-0037: this process's half of the startup timeline.
  const timeline = new SidecarTimeline((payload) => sink.emit("log", payload), deps.now);
  timeline.mark(
    "sidecar_started",
    deps.uptimeSeconds
      ? { processStartedAt: processStartedAt(deps.now(), deps.uptimeSeconds()).toISOString() }
      : {},
  );
  if (request.presentationSummary || request.modelJob) {
    const jobEnv = { ...inheritedEnv(deps.env), ...managedProxyEnvironment(deps.env) };
    const ended = request.modelJob
      ? await runModelJob(request, request.modelJob, deps, jobEnv, sink)
      : await presentationSummary(request, deps, jobEnv, sink);
    await sink.flush();
    if (!(await postEndedWithRetry(client, ended, deps))) {
      (opts.writeStdout ?? ((text: string) => void process.stdout.write(text)))(
        `${RUN_ENDED_STDOUT_PREFIX}${JSON.stringify(ended)}\n`,
      );
      opts.onEndedUndeliverable?.(ended);
    }
    return ended;
  }
  // ADR-0037 decision 7: a thread run streams its reply as it is written; the final message
  // stays authoritative. Runs without a thread have nowhere to show it.
  const preview =
    request.threadId === undefined
      ? undefined
      : new ReplyPreviewer({
          runId: request.runId,
          attempt: request.attempt,
          post: (frame) => client.postReplyPreview(frame),
          redact: (text) => redactText(text, secrets),
        });
  const recordScreenshot = screenshotRecorder(sink);
  // One `turn_usage` per model response (M3 context plan, Phase 1; `turn-usage.ts`).
  const turnUsage = new TurnUsageTracker((payload) => sink.emit("turn_usage", { ...payload }));
  const turnWarning = new TurnWarning(request.maxTurns);
  // ADR-0023 decision 3: the hook and SDK 0.3.278's overload-fallback message both feed it.
  const modelSwitches = new ModelSwitchRecorder((payload) =>
    sink.emit("model_switch", { ...payload }),
  );
  let cliCaptureActions = 0;
  const tty = deps.spawnPty ? new TtySessions(deps.spawnPty, deps.sleep) : undefined;
  let resourceSamplePending = false;
  let resourcesStopped = false;
  const sampleResources = async () => {
    if (!deps.observeResources || resourceSamplePending || resourcesStopped) return;
    resourceSamplePending = true;
    try {
      const sample = await deps.observeResources();
      if (!resourcesStopped)
        sink.emit("log", {
          source: "resource_observation",
          version: 1,
          workspaceId: request.workspaceId,
          ...sample,
        });
    } catch {
      /* Observations cannot fail a run. */
    } finally {
      resourceSamplePending = false;
    }
  };
  void sampleResources();
  const resourceTimer = deps.observeResources
    ? setInterval(() => void sampleResources(), 10_000)
    : undefined;
  resourceTimer?.unref();
  const statePath = browserStatePath(request.botHomeDir, request.runId);
  async function readBrowserState() {
    try {
      return parseBrowserState(await deps.fs.readFile(statePath), request.runId);
    } catch {
      return undefined;
    }
  }
  const trigger = request.trigger;
  const state = createRunState(
    trigger.kind === "approval" && request.sdkSessionId !== undefined
      ? {
          approvalId: trigger.approvalId,
          decision: trigger.decision,
          toolUseId: trigger.toolUseId,
          deferredAction: trigger.deferredAction,
          reason: trigger.reason,
        }
      : undefined,
    // The browser is still on the page the parked process left it on, so a click in this process
    // has that origin even though this process never navigated (ADR-0002 amendment 2).
    trigger.kind === "approval" ? trigger.currentOrigin : undefined,
  );

  // One capture directory per run. The proxy writes `<n>.json` into it before it forwards the
  // nth page-changing action's result, so the file is there by the time this process sees the
  // SDK's `tool_result` for that call (`screenshots.ts`).
  const screenshotDir =
    opts.screenshotDir ?? `${deps.env.TMPDIR ?? "/tmp"}/deskmates-shots-${request.runId}`;
  const skillDir = skillPluginDir(deps.env, request.runId, request.attempt);
  /** Page-changing browser calls so far, and the action number each tool-use id was given. */
  let pageChangingActions = 0;
  const actionOfToolUse = new Map<string, { toolName: string }>();

  // ADR-0011 decision 3: which response first saw untrusted content; learned items are stamped
  // against it (`memory-taint.ts`).
  const taint = new TaintTracker({
    trigger: request.trigger,
    ...(request.sessionTainted ? { sessionTainted: true } : {}),
    ...(request.sessionDoNotLearnReasons
      ? { sessionDoNotLearnReasons: request.sessionDoNotLearnReasons }
      : {}),
  });

  const ended: RunEnded = { type: "run_ended", runId: request.runId, outcome: "failed", usage: [] };
  let finalText = "";
  let lastAssistantText = "";
  /** Files this attempt wrote or edited through its file tools (ADR-0021 A3j). */
  const evidencePaths = new Set<string>();
  let latestToolResultUuid: string | undefined;
  let usage: RunUsageEntry[] = [];
  let resultSubtype: string | undefined;
  let resultIsError = false;
  let resultErrors: string[] = [];
  let canonicalSnapshots: CanonicalFileSnapshot[] = [];

  try {
    canonicalSnapshots = await prepareCanonicalFiles(request, deps.fs);
    canonicalSnapshots.push(
      ...(await snapshotPeerRuleFiles(request.peerBotHomeDirs ?? [], deps.fs)),
    );
    let knowledge: Awaited<ReturnType<GatewayClient["knowledgeSearch"]>> = [];
    if (request.tools.includes("knowledge_search")) {
      try {
        knowledge = await client.knowledgeSearch(knowledgeQuery(request.trigger));
        sink.emit("log", {
          source: "knowledge",
          op: "retrieved",
          documents: knowledge.map(({ id, version }) => ({ id, version })),
        });
      } catch {
        sink.emit("log", {
          source: "knowledge",
          level: "warn",
          error: "Reference retrieval unavailable",
        });
      }
    }
    // ADR-0038 decision 1: a per-bot run (the default) starts in the bot's own directory, which
    // other bots may read but not write (the hook's soft guard, decision 2). A directory that
    // cannot be created leaves the run in /work, not failed.
    let cwd = WORK_DIR;
    if (request.workdirMode === "per-bot") {
      const own = botWorkDir(request.botName);
      try {
        await deps.fs.mkdir(own);
        cwd = own;
      } catch (err) {
        sink.emit("log", {
          source: "workdir",
          level: "warn",
          reason: `bot working directory unavailable, starting in ${WORK_DIR}: ${String(err)}`,
        });
      }
      if (cwd !== WORK_DIR && request.sdkSessionId !== undefined)
        await carrySessionIntoBotDir(request, cwd, deps.fs, sink);
    }

    const context = await buildContext(request, deps.fs, deps.now(), knowledge);
    // What each part of the system prompt costs and which prompt this was, without the text
    // (M3 context plan, Phase 1). The hash also goes to `runs.config_json` through RunEnded.
    sink.emit("log", {
      source: "context",
      kind: "context_sections",
      sections: { ...context.sections },
      systemPromptSha256: context.systemPromptSha256,
    });
    ended.systemPromptSha256 = context.systemPromptSha256;

    // The run's skill set from the Gateway, written as this attempt's local plugin (ADR-0015
    // decision 1). The ledger names what was enabled; the Gateway already recorded it in
    // `runs.config_json`.
    const skillPlugin = await materializeSkillPlugin(request.skills ?? [], deps.fs, skillDir);
    if (skillPlugin.set.length > 0)
      sink.emit("log", { source: "skills", op: "enabled", set: skillPlugin.set });

    // Before the query: the proxy starts with the browser MCP server and captures from the first
    // action on, so the directory has to exist already. A failure here costs the run its
    // screenshots, not the run.
    try {
      await deps.fs.mkdir(screenshotDir);
    } catch (err) {
      sink.emit("log", {
        source: "screenshot",
        level: "warn",
        reason: `capture directory unavailable: ${String(err)}`,
      });
    }

    const hook = createPreToolUseHook({
      request,
      client,
      sink,
      state,
      readBrowserState,
      egressAllowlist: resolveAllowlist(request.egressAllowlist, deps.env),
      cwd,
      redact: (value) => redactValue(value, secrets),
      protectToolInput,
      now: deps.now,
      sleep: deps.sleep,
      ...(opts.approvalPollMs === undefined ? {} : { approvalPollMs: opts.approvalPollMs }),
    });

    const mcpServers: Record<string, McpServerConfig> = {
      // The computed directory, never the option: a real run supplies no option, and passing
      // the option here started the proxy without a capture directory in every real run.
      [BROWSER_MCP_SERVER]: browserMcpServer(deps.env, {
        screenshotDir,
        coordination: {
          runId: request.runId,
          gatewayBaseUrl: request.gatewayBaseUrl,
          token: request.modelAuthToken,
          statePath,
          attempt: request.attempt,
          ...(request.screenSlot === undefined ? {} : { screenSlot: request.screenSlot }),
          ...(request.browserCoordination ?? {}),
          ...(request.browserExecutionMode
            ? { browserExecutionMode: request.browserExecutionMode }
            : {}),
          ...(request.browserSnapshotMode === "inline-v2"
            ? {
                snapshotMode: "inline-v2" as const,
              }
            : {}),
        },
        ...(request.browserCoordination
          ? {
              // The SDK's per-tool hard wall must not preempt the Gateway-owned run deadline.
              // The outer sandbox deadline remains authoritative; this minute is cleanup margin.
              timeoutMs: Math.max(
                1000,
                Date.parse(request.browserCoordination.deadlineAt) - deps.now().getTime() + 60_000,
              ),
            }
          : {}),
        // ADR-0023 amendment 2: a model that cannot see gets notices, not screenshots.
        ...(withholdsImages(request) ? { withholdImages: true } : {}),
      }),
    };
    if (request.tools.length > 0) {
      mcpServers[DESKMATES_MCP_SERVER] = createThreadTools({
        request,
        client,
        sink,
        ...(deps.operationFiles ? { operationFiles: deps.operationFiles } : {}),
        ...(tty ? { tty, redactTerminal: (text: string) => redactText(text, secrets) } : {}),
        browserCli: {
          context: {
            runId: request.runId,
            cdpEndpoint: deps.env.DESKMATES_CDP_ENDPOINT ?? DEFAULT_CDP_ENDPOINT,
            coordination: {
              runId: request.runId,
              gatewayBaseUrl: request.gatewayBaseUrl,
              token: request.modelAuthToken,
              statePath,
              attempt: request.attempt,
              ...(request.screenSlot === undefined ? {} : { screenSlot: request.screenSlot }),
              ...(request.browserCoordination ?? {}),
              ...(request.browserExecutionMode
                ? { browserExecutionMode: request.browserExecutionMode }
                : {}),
            },
          },
          deps: {
            client,
            readBrowserState,
            onScreenshot: (capture) => {
              recordScreenshot({
                toolName: "mcp__deskmates__browser_cli_workflow",
                action: ++cliCaptureActions,
                ...capture,
              });
            },
          },
        },
        tool: deps.tool,
        createSdkMcpServer: deps.createSdkMcpServer,
      });
    }
    for (const connector of request.connectors) {
      // The connector tools themselves are registered with the thread tools (ADR-0012 item 3).
      const offered = request.tools.includes("connector_describe");
      sink.emit("log", {
        source: "connectors",
        connector,
        status: offered ? "offered" : "not offered",
      });
    }

    // The subprocess inherits only the environment on ENV_PASSTHROUGH (PATH, HOME, locale, the
    // display, DESKMATES_*) and never an upstream key: model access is the Gateway proxy plus the
    // per-run Bearer token (ADR-0002 decision 4).
    const env: Options["env"] = {
      ...inheritedEnv(deps.env),
      ...managedProxyEnvironment(deps.env),
      CLAUDE_CONFIG_DIR: `${request.botHomeDir}/.claude`,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      // The CLI's telemetry, error reporting and update checks go to hosts that are not on any
      // workspace allowlist. The only network the run may use is the Gateway (model proxy and
      // ledger) and what the egress rules allow through the browser.
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      ANTHROPIC_BASE_URL: request.modelBaseUrl,
      ANTHROPIC_AUTH_TOKEN: request.modelAuthToken,
    };
    // Recorded from what the CLI actually receives, not from the container environment: a value
    // the passthrough drops has no effect on compaction and must not be attributed to the run.
    // ADR-0044: the OpenAI runtime has its own knob, read from the same passthrough environment.
    const maxContextTokens =
      request.runtime === "openai-agents"
        ? maxContextTokensOf(env, "DESKMATES_OPENAI_MAX_CONTEXT_TOKENS")
        : maxContextTokensOf(env);
    if (maxContextTokens !== undefined) ended.maxContextTokens = maxContextTokens;
    // ADR-0023 decision 3: one `model_switch` per switch the SDK makes, whatever asked for it.
    // An overload fallback does not come through here in SDK 0.3.278 (see `model-switch.ts`).
    const postModelSwitch: HookCallback = async (input) => {
      if (input.hook_event_name !== "PostModelSwitch") return {};
      const payload: ModelSwitchPayload = {
        from: input.from_model,
        to: input.to_model,
        source: input.source,
        ...(input.requested_model === undefined ? {} : { requested: input.requested_model }),
      };
      modelSwitches.record(payload);
      return {};
    };
    const options: Options = {
      model: request.model,
      // Verbatim from the Gateway's FALLBACK_MODEL; absent leaves the SDK with no fallback.
      ...(request.fallbackModel === undefined ? {} : { fallbackModel: request.fallbackModel }),
      // The reasoning knob travels only when the Gateway resolved a value; an absent key leaves
      // the SDK's own default in force, which is what the run row's `sdk-default` means.
      ...(request.effort === undefined ? {} : { effort: request.effort }),
      ...(request.thinking === undefined ? {} : { thinking: request.thinking }),
      cwd,
      settingSources: [],
      // ADR-0015 decision 1: exactly one local plugin holding the run's skill set, and `skills`
      // naming exactly that set, so nothing the CLI could discover elsewhere is enabled.
      plugins: [skillPlugin.plugin],
      skills: skillPlugin.skills,
      permissionMode: "default",
      systemPrompt: context.systemPrompt,
      env,
      // The turn budget is a Gateway knob recorded in `runs.config_json`, not a container setting:
      // the environment belongs to the whole workspace and a value left there would silently run
      // every bot in it on a budget no run row can be attributed to.
      // `null` (the workspace's `off`) omits the option: SDK 0.3.278 then sets no turn cap.
      ...(request.maxTurns === null ? {} : { maxTurns: request.maxTurns }),
      // Final response usage arrives in message_delta after assistant content blocks.
      includePartialMessages: true,
      disallowedTools: [...DISALLOWED_TOOLS],
      mcpServers,
      hooks: {
        PreToolUse: [
          { hooks: [hook], timeout: request.shortWaitSeconds + HOOK_TIMEOUT_MARGIN_SECONDS },
        ],
        PostToolUse: [
          {
            hooks: [
              async () => {
                const warning = turnWarning.afterTool();
                if (warning) sink.emit("log", { source: "turn_budget", warning });
                return warning
                  ? {
                      hookSpecificOutput: {
                        hookEventName: "PostToolUse" as const,
                        additionalContext: warning,
                      },
                    }
                  : {};
              },
            ],
          },
        ],
        // Keeps the transcript the SDK is about to compact; fails open (`hooks/pre-compact.ts`).
        PreCompact: [
          {
            hooks: [
              createPreCompactHook({
                botHomeDir: request.botHomeDir,
                fs: deps.fs,
                sink,
                now: deps.now,
                latestToolResultUuid: () => latestToolResultUuid,
                memoryFlush: () => ({
                  taint: taint.snapshot(),
                  learned: taint.stamp(parseRunSummary(lastAssistantText).summary.learned ?? []),
                }),
              }),
            ],
          },
        ],
        PostModelSwitch: [{ hooks: [postModelSwitch] }],
      },
      canUseTool: createCanUseTool(sink, state, { browserCode: request.browserCodeApproval }),
      ...(request.sdkSessionId === undefined ? {} : { resume: request.sdkSessionId }),
    };

    timeline.mark("query_started", { resume: request.sdkSessionId !== undefined });
    // ADR-0044 decision 1: the run row froze which loop runs; both consume the same options and
    // yield the same message shapes, so everything below this line is runtime-neutral.
    const runtime = request.runtime ?? "claude-agent-sdk";
    let stream: AsyncIterable<SDKMessage>;
    if (runtime === "openai-agents") {
      if (deps.queryOpenAi === undefined)
        throw new Error("this sidecar cannot host the openai-agents runtime (ADR-0044)");
      stream = deps.queryOpenAi({
        prompt: context.prompt,
        options,
        modelBaseUrl: request.modelBaseUrl,
        modelAuthToken: request.modelAuthToken,
        botHomeDir: request.botHomeDir,
        botName: request.botName,
        runId: request.runId,
        cwd,
        skills: {
          dir: skillDir,
          names: skillPlugin.set.map((s) => s.name),
          readFile: (path) => deps.fs.readFile(path),
        },
        ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
      });
    } else {
      stream = deps.query({ prompt: context.prompt, options });
    }
    for await (const msg of stream) {
      timeline.observe(msg);
      preview?.observe(msg);
      await handleMessage(msg);
    }
    turnUsage.flush();
  } catch (err) {
    turnUsage.flush();
    const error = redactText(
      err instanceof Error ? (err.stack ?? err.message) : String(err),
      secrets,
    );
    // SDK 0.3.278 may emit error_max_turns, then throw the same result text when
    // its subprocess exits. Preserve that typed result for ADR-0016 parking;
    // never infer exhaustion from an exception alone or swallow a different failure.
    const resultText = resultErrors
      .map((text) => text.trim())
      .filter(Boolean)
      .join("; ");
    const repeatedTurnResult =
      resultSubtype === "error_max_turns" &&
      resultIsError &&
      resultText.length > 0 &&
      err instanceof Error &&
      err.message === `Claude Code returned an error result: ${resultText}`;
    if (!repeatedTurnResult) ended.error = error;
    sink.emit("log", {
      source: "sidecar",
      level: repeatedTurnResult ? "warn" : "error",
      error,
      ...(repeatedTurnResult ? { preservedResult: "error_max_turns" } : {}),
    });
  }

  for (const payload of await auditCanonicalFiles(canonicalSnapshots, deps.fs, secrets)) {
    sink.emit("rule_file_modified", payload);
  }

  tty?.dispose();
  if (resourceTimer) clearInterval(resourceTimer);
  await sampleResources();
  resourcesStopped = true;

  // Captures live as long as the run: they are in the ledger by now, and a parked run resumes in
  // a new process with a new MCP session that counts its actions from one again.
  try {
    await deps.fs.rm(screenshotDir);
  } catch {
    // Best effort; a leftover directory is a tmpfs entry, not a failed run.
  }
  // The skill plugin belongs to this attempt; a resumed attempt writes its own (ADR-0015).
  try {
    await deps.fs.rm(skillDir);
  } catch {
    // Best effort, as above.
  }

  /**
   * What the replayed call's result does to the human's decision. A resumed run is a new browser
   * MCP session, so the replayed call usually fails on a `ref` from the old process's snapshot:
   * the decision is then re-armed for the first retry of the same action in this process. A
   * result that is not an error spends it, and a later identical-looking call asks again
   * (ADR-0002 amendment 2).
   */
  function settleConsumedDecision(toolUseId: string, isError: boolean): void {
    const consumed = state.consumedDecision;
    if (consumed === undefined || consumed.toolUseId !== toolUseId) return;
    state.consumedDecision = undefined;
    if (!isError || consumed.deferredAction === undefined) return;
    state.retryDecision = {
      approvalId: consumed.approvalId,
      decision: consumed.decision,
      deferredAction: consumed.deferredAction,
      reason: consumed.reason,
      replayedToolUseId: toolUseId,
    };
  }

  /**
   * Read the capture of action `n`, waiting up to SCREENSHOT_WAIT_MS for it. The proxy writes the
   * file before it forwards the result, so in the normal case the first read finds it; the wait
   * covers a slow write and an in-flight partial one. Undefined means no capture: over a cap, too
   * large, or the capture failed. The reason is what the warn log says.
   */
  async function waitForCapture(
    action: number,
  ): Promise<{ file: ScreenshotFile } | { reason: string }> {
    const path = `${screenshotDir}/${screenshotFileName(action)}`;
    const deadline = deps.now().getTime() + SCREENSHOT_WAIT_MS;
    let sawFile = false;
    for (;;) {
      let text: string | undefined;
      try {
        text = await deps.fs.readFile(path);
      } catch {
        text = undefined;
      }
      if (text !== undefined) {
        sawFile = true;
        try {
          const skipped = JSON.parse(text) as { skipped?: unknown };
          if (typeof skipped.skipped === "string") return { reason: skipped.skipped };
        } catch {
          /* An incomplete file is polled below. */
        }
        const file = parseScreenshotFile(text);
        if (file !== undefined) return { file };
      }
      if (deps.now().getTime() >= deadline) {
        return {
          reason: sawFile
            ? "capture file never became readable JSON"
            : `no capture file after ${SCREENSHOT_WAIT_MS} ms`,
        };
      }
      await deps.sleep(SCREENSHOT_POLL_MS);
    }
  }

  /**
   * The `screenshot` event that follows a page-changing action's `tool_result`. The action is
   * numbered here, at result time, and only for calls the hook let through: a refused call never
   * reached the proxy, so the proxy's counter did not move for it, and counting it here would put
   * every later capture one action off.
   */
  async function emitScreenshot(toolUseId: string): Promise<void> {
    const pending = actionOfToolUse.get(toolUseId);
    if (pending === undefined) return;
    actionOfToolUse.delete(toolUseId);
    if (state.deniedToolUseIds.has(toolUseId)) return;
    pageChangingActions += 1;
    const action = pageChangingActions;
    // Past the cap the proxy stopped capturing; a missing file there is expected, not a warning.
    if (action > SCREENSHOT_MAX_PER_RUN) return;
    const got = await waitForCapture(action);
    if ("reason" in got) {
      sink.emit("log", {
        source: "screenshot",
        level: "warn",
        action,
        reason: got.reason,
      });
      return;
    }
    if (got.file.tabId) {
      const lock = await client
        .browserLock({
          type: "browser_lock",
          runId: request.runId,
          op: "renew",
          tabId: got.file.tabId,
        })
        .catch(() => undefined);
      if (
        !lock?.granted ||
        (got.file.browserEpoch !== undefined && got.file.browserEpoch !== (lock.epoch ?? 0))
      )
        return;
    }
    recordScreenshot({
      ...(got.file.tabId ? { tabId: got.file.tabId } : {}),
      ...(got.file.browserEpoch !== undefined ? { browserEpoch: got.file.browserEpoch } : {}),
      toolName: pending.toolName,
      toolUseId,
      action,
      mimeType: got.file.mimeType,
      base64: got.file.base64,
      bytes: got.file.bytes,
      takenAt: got.file.takenAt,
    });
  }

  async function handleMessage(msg: SDKMessage): Promise<void> {
    if (msg.type === "stream_event") {
      const event = msg.event;
      if (
        event.type === "message_start" ||
        event.type === "message_delta" ||
        event.type === "message_stop"
      ) {
        turnUsage.observeStream({ parent_tool_use_id: msg.parent_tool_use_id, event });
      }
      return;
    }
    if (msg.type === "system" && msg.subtype === "init") {
      state.sdkSessionId = msg.session_id;
      // The CLI build and the model id the SDK resolved for this attempt: a CLI-side failure such
      // as `unrecognized_model` is only explainable when they sit next to the error (issue #68).
      sink.emit("log", {
        source: "sdk",
        usageSessionFingerprint: createHash("sha256").update(msg.session_id).digest("hex"),
        ...(msg.claude_code_version === undefined ? {} : { cliVersion: msg.claude_code_version }),
        ...(msg.model === undefined ? {} : { model: msg.model }),
      });
      return;
    }
    if (msg.type === "system" && msg.subtype === "api_retry") {
      const payload: ModelRetryPayload = {
        attempt: msg.attempt,
        maxRetries: msg.max_retries,
        retryDelayMs: msg.retry_delay_ms,
        errorStatus: msg.error_status,
        error: msg.error,
      };
      sink.emit("model_retry", { ...payload });
      return;
    }
    // Not in the SDK's message union, so it is read as `unknown` through its own narrow type.
    const untyped: unknown = msg;
    if (isModelFallbackMessage(untyped)) {
      modelSwitches.record(fallbackSwitch(untyped));
      return;
    }
    if (msg.type === "system" && msg.subtype === "compact_boundary") {
      turnUsage.flush();
      const meta = msg.compact_metadata;
      sink.emit("compact_boundary", {
        trigger: meta.trigger,
        preTokens: meta.pre_tokens,
        ...(typeof meta.post_tokens === "number" ? { postTokens: meta.post_tokens } : {}),
      });
      return;
    }
    if (msg.type === "assistant") {
      state.sdkSessionId = msg.session_id;
      turnUsage.observe(msg);
      turnWarning.observeAssistant(msg.message.id);
      modelSwitches.observeAssistant(msg.message.id);
      taint.observeAssistant(msg.message.id);
      for (const block of msg.message.content) {
        if (block.type === "thinking") {
          sink.emit("thinking", { text: block.thinking });
        } else if (block.type === "text") {
          lastAssistantText = block.text;
          sink.emit("log", { source: "assistant", text: block.text });
        } else if (block.type === "tool_use") {
          const input =
            block.input && typeof block.input === "object"
              ? (block.input as Record<string, unknown>)
              : {};
          // ADR-0021 A3j: pointers to what this attempt wrote, for the handoff.
          const written = FILE_TOOLS.has(block.name)
            ? (input.file_path ?? input.notebook_path)
            : undefined;
          if (typeof written === "string" && written.length <= 4096) evidencePaths.add(written);
          // Same classification as screenshots: the browser MCP server, or a bare browser_ name.
          const named = splitMcpToolName(block.name);
          if (
            (named.server ?? BROWSER_MCP_SERVER) === BROWSER_MCP_SERVER &&
            named.tool.startsWith("browser_")
          )
            browserToolUses.add(block.id);
          protectToolInput(block.name, input);
          taint.observeToolUse(block.id, block.name, input);
          sink.emit("tool_call", {
            toolUseId: block.id,
            toolName: block.name,
            input,
            riskLevel: riskTier(block.name, input, { browserCode: request.browserCodeApproval }),
          });
          // Remembered here, numbered when its result arrives (`emitScreenshot`): the proxy
          // counts the calls that reach it, so action n is the nth page-changing call the hook
          // let through and the proxy's file n (`screenshots.ts`).
          if (isPageChangingBrowserTool(block.name)) {
            actionOfToolUse.set(block.id, { toolName: block.name });
          }
        }
      }
      return;
    }
    if (msg.type === "user") {
      const content = msg.message.content;
      if (!Array.isArray(content)) return;
      // The SDK can yield the result before appending it to the transcript. Preserve the
      // top-level record watermark before any screenshot wait or PreCompact callback.
      if (
        msg.parent_tool_use_id === null &&
        content.some((block) => block.type === "tool_result")
      ) {
        latestToolResultUuid = msg.uuid;
      }
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const isError = block.is_error === true;
        const resultText = toolResultText(block.content);
        taint.observeToolResult(block.tool_use_id, resultText);
        sink.emit("tool_result", {
          toolUseId: block.tool_use_id,
          ...(await ledgerToolResult(
            resultText,
            browserToolUses.delete(block.tool_use_id),
            secrets,
            deps.saveToolEvidence,
          )),
          isError,
        });
        settleConsumedDecision(block.tool_use_id, isError);
        await emitScreenshot(block.tool_use_id);
      }
      return;
    }
    if (msg.type === "result") {
      turnUsage.flush();
      state.sdkSessionId = msg.session_id;
      resultSubtype = msg.subtype;
      resultIsError = msg.is_error;
      usage = usageFromResult(msg.modelUsage);
      if (msg.subtype === "success") finalText = msg.result;
      else resultErrors = msg.errors;
    }
  }

  ended.usage = usage;
  if (state.sdkSessionId !== undefined) ended.sdkSessionId = state.sdkSessionId;

  let summary: RunSummary | undefined;
  if (ended.error === undefined) {
    if (state.deferredApprovalId !== undefined) {
      ended.outcome = "deferred";
      ended.pendingApprovalId = state.deferredApprovalId;
      if (state.deferredToolUseId !== undefined) ended.pendingToolUseId = state.deferredToolUseId;
      // The page the browser is left on, so the resumed process can judge a click before it
      // navigates again (ADR-0002 amendment 2).
      if (state.currentOrigin !== undefined) ended.currentOrigin = state.currentOrigin;
    } else if (resultSubtype === "success" && !resultIsError) {
      ended.outcome = "completed";
      summary = parseRunSummary(finalText, lastAssistantText).summary;
      // Trust is the sidecar's call, never the model's; the legacy field rides along for one
      // release as bot-scope candidates formed at the last turn (ADR-0011).
      summary = {
        ...summary,
        learned: taint.stamp([
          ...(summary.learned ?? []),
          ...learnedFromSuggestions(summary.memorySuggestions, taint.turnCount),
        ]),
      };
      summary = redactValue(summary, secrets) as RunSummary;
      ended.summary = summary;
    } else {
      ended.outcome = resultSubtype === "error_max_turns" ? "turns_exhausted" : "failed";
      ended.error = redactText(
        resultErrors.length > 0
          ? resultErrors.join("; ")
          : `SDK result: ${resultSubtype ?? "none"}`,
        secrets,
      );
    }
  }

  // The handoff is not only an exhaustion artifact (issue #68). A run whose SDK process dies
  // mid-run, or ends on an error result, loses the same work an exhausted one does, so a failed
  // run writes the same bounded file whenever the bot said something. A failure before the first
  // assistant turn has nothing to preserve and writes nothing. ADR-0021 A3j: exhaustion writes
  // the handoff even without prose, and every handoff carries the Gateway identity and evidence
  // pointers (files written, latest checkpoints), so a continuation need not reconstruct them.
  if (
    ended.outcome === "turns_exhausted" ||
    (ended.outcome === "failed" && (lastAssistantText.trim() !== "" || evidencePaths.size > 0))
  ) {
    const path = `/work/handoffs/${request.runId}-attempt-${request.attempt}.md`;
    try {
      await deps.fs.writeFile(
        path,
        redactText(handoffText(request, lastAssistantText, [...evidencePaths]), secrets),
      );
      ended.handoffPath = path;
    } catch {
      sink.emit("log", {
        source: ended.outcome === "turns_exhausted" ? "turn_budget" : "handoff",
        error: "handoff file could not be saved",
      });
    }
  }

  ended.taint = taint.snapshot();
  await appendDiary(request, deps, ended, summary);
  // A preview must not arrive after the final reply it is replaced by.
  await preview?.flush();
  await sink.flush();
  if (!(await postEndedWithRetry(client, ended, deps))) {
    // Last resort. Without this line a lost post turns a completed run into `failed` on the
    // Gateway and throws away the reply the human is waiting for; the supervisor that launched
    // this process can still read it off stdout and post it itself.
    const line = `${RUN_ENDED_STDOUT_PREFIX}${JSON.stringify(ended)}\n`;
    (opts.writeStdout ?? ((text: string) => void process.stdout.write(text)))(line);
    opts.onEndedUndeliverable?.(ended);
  }
  return ended;
}

/**
 * `RunEnded` is the only message that decides how the Gateway records the run, so one dropped
 * packet must not cost it. Five attempts over about 15 s, then the caller falls back to stdout.
 */
async function postEndedWithRetry(
  client: GatewayClient,
  ended: RunEnded,
  deps: SidecarDeps,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await client.postEnded(ended);
      return true;
    } catch (err) {
      process.stderr.write(
        `run_ended post failed (attempt ${attempt + 1}): ${describeError(err)}\n`,
      );
      const delay = ENDED_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) return false;
      await deps.sleep(delay);
    }
  }
}

async function appendDiary(
  request: StartRunRequest,
  deps: SidecarDeps,
  ended: RunEnded,
  summary: RunSummary | undefined,
): Promise<void> {
  const now = deps.now();
  const time = now.toISOString().slice(11, 16);
  const what = summary?.done || summary?.reply || ended.error || "";
  const line = `- ${time} run ${request.runId} (${request.trigger.kind}) ${ended.outcome}${what ? `: ${truncate(what.replace(/\s+/g, " "), 200)}` : ""}\n`;
  try {
    await deps.fs.appendFile(
      diaryPath(request.botHomeDir, now),
      redactText(line, [request.modelAuthToken]),
    );
  } catch (err) {
    process.stderr.write(`diary append failed: ${String(err)}\n`);
  }
}
