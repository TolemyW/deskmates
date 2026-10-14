// The stdio proxy in front of the browser MCP server (ADR-0002 amendment 1, recorded gap;
// AGENTS.md "Page content is untrusted"). It sits between the SDK's MCP client and the real
// `playwright-mcp` process and speaks the same newline-delimited JSON-RPC 2.0 on both sides.
//
// It exists because the SDK gives no hook on a tool *result*: `PreToolUse` and `canUseTool` both
// run before the call. The only place page text can be relabelled before it enters model context
// is the wire the MCP server answers on.
//
// Responsibilities:
//
//  1. Wrap. Every `text` item of every `tools/call` result is replaced by `wrapPageContent`, with
//     the origin of the last URL the SDK navigated to. `image` items and every other message pass
//     through untouched. This proxy only ever fronts the browser MCP server (`browser-mcp.ts` is
//     the sole caller), so every `tools/call` it sees is a browser call and every result is page
//     derived: there is no tool-name allowlist to keep in step with the MCP release.
//  2. Capture. After a page-changing action (`isPageChangingBrowserTool`) it asks the same server
//     for a viewport JPEG and writes it where the run process reads it (`screenshots.ts`). The
//     capture happens before the action's result is forwarded, so the image is of the page the
//     model is about to be told about, not of whatever it did next.
//
//  3. Coordinate actual selected tabs and fence results/captures across human takeover.
//     Risk classification, egress checks and approval remain in PreToolUse.
//
// What it is not: a security boundary. The container network is open and the bot has a shell in
// the same workspace, so a bot that wants raw page bytes can fetch them. The wrapper is about the
// model reading page text as data, which is the failure mode that actually happens.
//
// The ledger is unaffected: `run-once.ts` records the SDK's `tool_result`, which is what the
// model saw, wrapper and all.

import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_PER_RUN,
  SCREENSHOT_MIME,
  type ScreenshotFile,
  isPageChangingBrowserTool,
  screenshotFileName,
} from "../screenshots.js";
import { wrapPageContent } from "../untrusted.js";
import { withholdResultImages } from "../vision-withhold.js";
import {
  type BrowserCall,
  type BrowserCoordination,
  stripTabIdentity,
} from "./browser-coordinator.js";
import {
  MAX_RETENTION_CLOSES_PER_START,
  parseRetentionReceipt,
  retentionCloseCall,
} from "./browser-retention.js";
import type { TimingOutcome, TimingRecorder, TimingSpan } from "./timing.js";
import { VisionFallbackTracker } from "./vision-fallback.js";

/**
 * Id space the proxy reserves for its own requests. JSON-RPC ids only have to be unique per
 * connection, and the SDK's client numbers its own from 0, so a string prefix no client would
 * emit keeps the two apart with no bookkeeping: a response whose id starts with this is the
 * proxy's and is consumed here, never forwarded.
 */
export const CAPTURE_ID_PREFIX = "deskmates-shot-";

export const SCREENSHOT_TOOL = "browser_take_screenshot";
export const INLINE_SNAPSHOT_TOOL = "browser_snapshot";

/**
 * Arguments for the capture. `@playwright/mcp` 0.0.82 only attaches the image to the result when
 * no `filename` is given (`registerImageResult` is called under `if (!params.filename)`), so the
 * argument is deliberately absent: the proxy needs the bytes, not a path inside the container.
 * `fullPage: false` and `scale: "css"` keep a capture to tens of kilobytes, well under
 * SCREENSHOT_MAX_BYTES; the MCP picks quality 90 for jpeg.
 */
const SCREENSHOT_ARGS = { type: "jpeg", fullPage: false, scale: "css" } as const;

/** Longest the proxy waits for its own capture before giving up on it and forwarding. */
export const CAPTURE_TIMEOUT_MS = 5000;
export const INLINE_SNAPSHOT_TIMEOUT_MS = 5000;
export const INLINE_SNAPSHOT_MAX_TEXT_BYTES = 512_000;

export interface McpProxyEndpoint {
  /** Lines from the SDK's MCP client (this process's stdin in production). */
  input: Readable;
  /** Lines to the SDK's MCP client (this process's stdout in production). */
  output: Writable;
}

export interface McpProxyChild {
  stdin: Writable;
  stdout: Readable;
}

export interface McpProxyOptions {
  /** Where captures go; unset means no captures at all (`SCREENSHOT_DIR_ENV`). */
  screenshotDir?: string;
  /** Present for real run sessions; legacy standalone proxy users retain wrapping/capture only. */
  coordination?: BrowserCoordination;
  captureTimeoutMs?: number;
  now?: () => Date;
  timing?: TimingRecorder;
  /** Opt-in host read after successful page-changing actions. Absent preserves explicit-v1. */
  inlineSnapshot?: {
    allowed(url: string): Promise<boolean>;
    timeoutMs?: number;
  };
  /** Opt-in strategy knob: attach a fenced screenshot after two matching locator failures. */
  visionFallback?: boolean;
  /** ADR-0023 amendment 2: replace image items with a notice and attach no fallback image. */
  withholdImages?: boolean;
  /** Gateway-selected terminal run targets. Cleanup runs once, before the first model browser call. */
  retention?: {
    candidates(): Promise<readonly string[]>;
    acquire(targetId: string): Promise<{ granted: boolean; epoch?: number }>;
    closed(targetIds: readonly string[]): Promise<void>;
  };
  /** Diagnostics; defaults to this process's stderr, which the child's stderr shares. */
  log?: (message: string) => void;
}

export interface McpProxyParams {
  upstream: McpProxyEndpoint;
  child: McpProxyChild;
  options?: McpProxyOptions;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface RememberedCall {
  name: string;
  arguments: Record<string, unknown>;
}

function parseLine(line: string): JsonRpcMessage | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return value as JsonRpcMessage;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The origin of a URL a browser tool was pointed at. `about:blank` and `data:` URLs have the
 * origin `"null"`, which says nothing; they are reported as no origin so the wrapper says
 * `page:unknown` rather than `page:null`.
 */
function originOf(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Replace every `text` item of a tool result with its wrapped form; `image` items stay put. */
function wrapResultMessage(msg: JsonRpcMessage, origin: string | undefined): JsonRpcMessage {
  const result = msg.result;
  if (!result || typeof result !== "object") return msg;
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return msg;
  const wrapped = content.map((item: unknown) => {
    const block = asRecord(item);
    if (block.type !== "text" || typeof block.text !== "string") return item;
    return { ...block, text: wrapPageContent(origin, block.text) };
  });
  return { ...msg, result: { ...(result as Record<string, unknown>), content: wrapped } };
}

function findImage(msg: JsonRpcMessage): { data: string; mimeType: string } | undefined {
  const content = (asRecord(msg.result).content ?? []) as unknown[];
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    const block = asRecord(item);
    if (block.type === "image" && typeof block.data === "string") {
      return {
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : SCREENSHOT_MIME,
      };
    }
  }
  return undefined;
}

function resultIsError(result: unknown): boolean {
  return asRecord(result).isError === true;
}

function appendResultText(result: unknown, text: string): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  return { ...record, content: [...content, { type: "text", text }] };
}

function appendResultImage(result: unknown, image: { data: string; mimeType: string }): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const record = result as Record<string, unknown>;
  const content = Array.isArray(record.content) ? record.content : [];
  return {
    ...record,
    content: [...content, { type: "image", data: image.data, mimeType: image.mimeType }],
  };
}

function inlineSnapshotText(result: unknown): string | undefined {
  if (resultIsError(result)) return undefined;
  const content = asRecord(result).content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map(asRecord)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
  if (text.length === 0 || Buffer.byteLength(text, "utf8") > INLINE_SNAPSHOT_MAX_TEXT_BYTES)
    return undefined;
  return text;
}

/** A proxy-internal RPC got no answer within its bound. */
class RpcTimeoutError extends Error {
  constructor() {
    super("Browser MCP call timed out");
  }
}

type InlineFailure = "unavailable" | "egress" | "changed" | "tainted";

function inlineFailureDiagnostic(reason: InlineFailure): string {
  if (reason === "tainted")
    return "[Deskmates host diagnostic] The inline snapshot timed out, so page-derived output was suppressed and this browser observation session was ended. The original browser action may have completed.";
  const detail = {
    unavailable: "The inline snapshot was unavailable.",
    egress: "The inline snapshot was denied because its live egress check did not pass.",
    changed: "The inline snapshot was discarded because browser control or page identity changed.",
    tainted: "",
  }[reason];
  return `[Deskmates host diagnostic] ${detail} The original browser action may have completed, and its result above is preserved.`;
}

/**
 * Run the proxy until the child's stdout closes. Pure over the four streams: the caller owns the
 * child process, so this is testable with in-memory duplexes and holds no process state.
 */
export function runMcpProxy(params: McpProxyParams): Promise<void> {
  const { upstream, child } = params;
  const options = params.options ?? {};
  const log = options.log ?? ((message: string) => void process.stderr.write(`${message}\n`));
  const now = options.now ?? (() => new Date());
  const captureTimeoutMs = options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;
  const screenshotDir = options.screenshotDir;

  /** `tools/call` requests the SDK made and the child has not answered yet, by id. */
  const calls = new Map<string, RememberedCall>();
  /** Capture requests this proxy made and is waiting on, by its own reserved id. */
  const captureWaiters = new Map<string, (msg: JsonRpcMessage | undefined) => void>();
  let currentOrigin: string | undefined;
  /** Page-changing actions seen so far; the nth one pairs with `<dir>/<n>.json`. */
  let pageChangingCount = 0;
  /** Child lines are handled one at a time so a capture cannot reorder the stream. */
  let queue: Promise<void> = Promise.resolve();
  let dispatchQueue: Promise<void> = Promise.resolve();
  let rpcCounter = 0;
  const rpcWaiters = new Map<string, (message: JsonRpcMessage | undefined) => void>();
  const coordination = options.coordination;
  const timing = options.timing;
  const inlineSnapshot = options.inlineSnapshot;
  // ADR-0023 amendment 2: a model that cannot see gets no fallback screenshot, and every image
  // item of a result becomes a host notice (after wrapping: the notice is not page content).
  const withholdImages = options.withholdImages === true;
  const visionFallback =
    options.visionFallback && !withholdImages ? new VisionFallbackTracker() : undefined;
  const withheld = (msg: JsonRpcMessage): JsonRpcMessage =>
    withholdImages && msg.result !== undefined
      ? { ...msg, result: withholdResultImages(msg.result) }
      : msg;
  let childClosed = false;
  let inlineSessionTainted = false;
  let retentionStarted = false;

  const startSpan = (
    phase: Parameters<TimingRecorder["start"]>[0],
    toolName?: string,
    parentSpanId?: string,
  ): TimingSpan | undefined => {
    try {
      return timing?.start(phase, {
        ...(toolName ? { toolName } : {}),
        ...(parentSpanId ? { parentSpanId } : {}),
      });
    } catch {
      return undefined;
    }
  };

  const observed = async <T>(
    phase: Parameters<TimingRecorder["start"]>[0],
    toolName: string | undefined,
    parentSpanId: string | undefined,
    operation: (spanId?: string) => Promise<T>,
  ): Promise<T> => {
    const span = startSpan(phase, toolName, parentSpanId);
    const end = (outcome: TimingOutcome) => {
      try {
        span?.end(outcome);
      } catch {}
    };
    try {
      const value = await operation(span?.spanId);
      end("ok");
      return value;
    } catch (error) {
      end(childClosed ? "cancelled" : "error");
      throw error;
    }
  };

  const toChild = (line: string): void => void child.stdin.write(`${line}\n`);
  const toUpstream = (line: string): void => void upstream.output.write(`${line}\n`);

  const fromUpstream = createInterface({
    input: upstream.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  fromUpstream.on("line", (line: string) => {
    const msg = parseLine(line);
    if (coordination && msg?.method === "tools/call" && msg.id !== undefined) {
      const contextKey = coordination.contextKey?.();
      const callParams = asRecord(msg.params);
      const toolName = typeof callParams.name === "string" ? callParams.name : undefined;
      const queueSpan = startSpan("proxy_queue", toolName);
      dispatchQueue = dispatchQueue
        .then(() => dispatchCoordinated(msg, contextKey, queueSpan))
        .catch((error: unknown) => log(`mcp-proxy: ${String(error)}`));
      return;
    }
    if (msg !== undefined && msg.method === "tools/call" && msg.id !== undefined) {
      const callParams = asRecord(msg.params);
      const args = asRecord(callParams.arguments);
      if (typeof callParams.name === "string") {
        calls.set(String(msg.id), { name: callParams.name, arguments: args });
      }
      // `browser_navigate` carries `url`; so does `browser_tabs {action: "new", url}`. Any
      // argument called `url` moves the page, so the origin follows it rather than a tool name.
      const origin = originOf(args.url);
      if (origin !== undefined) currentOrigin = origin;
    }
    toChild(line);
  });
  fromUpstream.on("close", () => {
    coordination?.cancel?.();
    void dispatchQueue.finally(() => child.stdin.end());
  });

  const fromChild = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  fromChild.on("line", (line: string) => {
    const msg = parseLine(line);
    if (msg && typeof msg.id === "string" && msg.id.startsWith("deskmates-internal-")) {
      rpcWaiters.get(msg.id)?.(msg);
      return;
    }
    // The proxy's own responses are settled here, outside the queue: `handleFromChild` blocks the
    // queue while it waits for exactly this line, so queueing it would deadlock the stream.
    if (msg !== undefined && typeof msg.id === "string" && msg.id.startsWith(CAPTURE_ID_PREFIX)) {
      captureWaiters.get(msg.id)?.(msg);
      return;
    }
    queue = queue
      .then(() => handleFromChild(line, msg))
      .catch((err: unknown) => {
        log(`mcp-proxy: forwarding failed: ${String(err)}`);
      });
  });

  /**
   * `endSessionOnTimeout: false` is only for host-authored identity and focus probes: a late
   * answer to one cannot change reference state, and is dropped because its waiter is gone.
   */
  async function rpcWithTimeout(
    call: BrowserCall,
    timeoutMs: number,
    endSessionOnTimeout = true,
  ): Promise<unknown> {
    if (childClosed) throw new Error("Browser MCP connection closed");
    const id = `deskmates-internal-${++rpcCounter}`;
    let timedOut = false;
    const answer = await new Promise<JsonRpcMessage | undefined>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        // An unacknowledged call may still be running. End this MCP session so a late snapshot
        // cannot mutate reference state underneath a later model decision.
        if (endSessionOnTimeout) {
          childClosed = true;
          child.stdin.end();
        }
        rpcWaiters.delete(id);
        resolve(undefined);
      }, timeoutMs);
      rpcWaiters.set(id, (message) => {
        clearTimeout(timer);
        rpcWaiters.delete(id);
        resolve(message);
      });
      toChild(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: call.name, arguments: call.arguments },
        }),
      );
    });
    if (!answer && timedOut) throw new RpcTimeoutError();
    if (!answer) throw new Error("Browser MCP call timed out or disconnected");
    if (answer.error) throw new Error(`Browser MCP error: ${JSON.stringify(answer.error)}`);
    return answer.result;
  }

  const rpc = (call: BrowserCall): Promise<unknown> => rpcWithTimeout(call, 90_000);

  async function inlineFreshSnapshot(
    toolName: string,
    actionResult: unknown,
  ): Promise<{ result: unknown; diagnostic?: string; sessionTainted?: boolean }> {
    const expectedTarget = coordination?.tabId();
    const expectedEpoch = coordination?.epoch();
    const diagnostic = (reason: InlineFailure, sessionTainted = false) => ({
      result: actionResult,
      diagnostic: inlineFailureDiagnostic(reason),
      ...(sessionTainted ? { sessionTainted: true } : {}),
    });
    if (!expectedTarget || expectedEpoch === undefined) return diagnostic("unavailable");
    try {
      if (!(await fence(toolName, undefined))) return diagnostic("changed");
      const before = coordination?.verifiedPage?.();
      if (!before || before.tabId !== expectedTarget || before.epoch !== expectedEpoch)
        return diagnostic("changed");
      currentOrigin = originOf(before.url) ?? currentOrigin;
      if (!(await inlineSnapshot?.allowed(before.url))) return diagnostic("egress");
      const snapshotResult = await observed("browser_snapshot_rpc", toolName, undefined, () =>
        rpcWithTimeout(
          { name: INLINE_SNAPSHOT_TOOL, arguments: {} },
          inlineSnapshot?.timeoutMs ?? INLINE_SNAPSHOT_TIMEOUT_MS,
        ),
      );
      if (!(await fence(toolName, undefined))) return diagnostic("changed");
      const after = coordination?.verifiedPage?.();
      if (
        !after ||
        after.tabId !== before.tabId ||
        after.epoch !== before.epoch ||
        after.url !== before.url
      )
        return diagnostic("changed");
      if (!(await inlineSnapshot?.allowed(after.url))) return diagnostic("egress");
      const text = inlineSnapshotText(snapshotResult);
      if (!text) return diagnostic("unavailable");
      currentOrigin = originOf(after.url) ?? currentOrigin;
      return {
        result: appendResultText(
          actionResult,
          `[Deskmates inline fresh snapshot after ${toolName}]\n${text}`,
        ),
      };
    } catch {
      if (childClosed) {
        inlineSessionTainted = true;
        return diagnostic("tainted", true);
      }
      return diagnostic("changed");
    }
  }

  async function writeSkipped(action: number, toolName: string, reason: string): Promise<void> {
    if (!screenshotDir || action > SCREENSHOT_MAX_PER_RUN) return;
    try {
      await writeCaptureFile(screenshotDir, action, { action, toolName, skipped: reason });
    } catch (error) {
      log(`mcp-proxy: skipped capture marker failed: ${String(error)}`);
    }
  }

  async function dispatchCoordinated(
    message: JsonRpcMessage,
    contextKey?: string,
    queueSpan?: TimingSpan,
  ): Promise<void> {
    const coordinator = coordination;
    if (!coordinator) throw new Error("Browser coordination unavailable");
    const params = asRecord(message.params);
    const call = { name: String(params.name), arguments: asRecord(params.arguments) };
    const timingToolName = typeof params.name === "string" && params.name ? params.name : undefined;
    try {
      queueSpan?.end("ok");
    } catch {}
    const action = isPageChangingBrowserTool(call.name) ? ++pageChangingCount : undefined;
    let result: unknown;
    let hostDiagnostic: string | undefined;
    let skipFinalFence = false;
    try {
      if (inlineSessionTainted) throw new Error("deskmates_inline_snapshot_session_tainted");
      if (contextKey !== coordination?.contextKey?.())
        throw new Error(
          "The selected page changed while this call was queued. Inspect the page and retry with a fresh tool decision.",
        );
      const prepared = await observed("browser_before", timingToolName, undefined, (spanId) =>
        coordinator.before(call, rpc, spanId),
      );
      // `before` establishes the exact run target and its tab lease. Old terminal targets can
      // now be closed without operating from an MCP fallback page.
      await ensureRetentionCleanup();
      const epoch = coordinator.epoch();
      result = await observed("browser_rpc", timingToolName, undefined, () =>
        rpc(prepared ?? call),
      );
      await observed("browser_after", timingToolName, undefined, () =>
        coordinator.after(call, rpc, result),
      );
      if (visionFallback?.observe(call, result)) {
        const image = await captureForVisionFallback(call.name);
        if (image) {
          result = appendResultImage(result, image);
          hostDiagnostic =
            "[Deskmates host diagnostic] Two matching target lookups failed. A fresh, fenced screenshot is attached for visual inspection. The failed action was not retried.";
        } else {
          hostDiagnostic =
            "[Deskmates host diagnostic] Two matching target lookups failed, but a fresh screenshot could not be safely attached. The failed action was not retried.";
        }
      }
      // MCP selects a fallback page when the current tab closes. Do not expose that page.
      if (!coordinator.tabId())
        result = {
          content: [
            {
              type: "text",
              text: "The run tab was closed. The next browser call will open a fresh tab.",
            },
          ],
        };
      if (action !== undefined && screenshotDir && action <= SCREENSHOT_MAX_PER_RUN)
        await capture(action, call.name, screenshotDir);
      if (action !== undefined && inlineSnapshot && !resultIsError(result)) {
        const inline = await inlineFreshSnapshot(call.name, result);
        result = inline.result;
        hostDiagnostic = inline.diagnostic;
        skipFinalFence = inline.sessionTainted === true;
        if (skipFinalFence) result = { isError: true, content: [] };
      }
      if (
        (!skipFinalFence && coordinator.tabId() && !(await fence(timingToolName, undefined))) ||
        epoch !== coordinator.epoch()
      )
        throw new Error(
          childClosed
            ? "The browser connection was reset during the call. The action may have completed; inspect the page before retrying."
            : "Browser control changed during the call. The action may have completed; verify state after handback before retrying.",
        );
    } catch (error) {
      visionFallback?.reset();
      await coordinator.onError?.().catch((cleanupError: unknown) => {
        log(`mcp-proxy: origin cleanup failed: ${String(cleanupError)}`);
      });
      const reason = error instanceof Error ? error.message : String(error);
      if (reason === "deskmates_inline_snapshot_session_tainted") {
        result = { isError: true, content: [] };
        hostDiagnostic = inlineFailureDiagnostic("tainted");
      } else {
        result = { isError: true, content: [{ type: "text", text: reason }] };
        hostDiagnostic = undefined;
      }
      if (action !== undefined) await writeSkipped(action, call.name, reason);
    }
    // The coordinator has read the shim's identity line; the model sees MCP's own output.
    if (call.name === "browser_tabs") result = stripTabIdentity(result);
    const origin = originOf(call.arguments.url);
    if (!inlineSnapshot && origin) currentOrigin = origin;
    let outgoing = withheld(
      wrapResultMessage({ jsonrpc: "2.0", id: message.id, result }, currentOrigin),
    );
    if (hostDiagnostic) {
      outgoing = {
        ...outgoing,
        result: appendResultText(outgoing.result, hostDiagnostic),
      };
    }
    toUpstream(JSON.stringify(outgoing));
  }

  async function ensureRetentionCleanup(): Promise<void> {
    if (retentionStarted || !options.retention || !coordination) return;
    retentionStarted = true;
    let candidates: readonly string[];
    try {
      candidates = await options.retention.candidates();
    } catch (error) {
      log(`mcp-proxy: retention candidates unavailable: ${String(error)}`);
      return;
    }
    const unique = [...new Set(candidates)]
      .filter((targetId) => typeof targetId === "string" && targetId.length > 0)
      .slice(0, MAX_RETENTION_CLOSES_PER_START);
    const closed: string[] = [];
    for (const targetId of unique) {
      let currentTarget: string | undefined;
      try {
        // This renews the current run's own tab lease and focuses its tab. The candidate gets a
        // separate exact-target lease below; human takeover keeps priority by failing either.
        if (!(await fence("browser_retention_cleanup", undefined, true))) break;
        const epoch = coordination.epoch();
        currentTarget = coordination.tabId();
        if (!currentTarget || currentTarget === targetId) continue;
        // Tab leases are per target. Claim the old target immediately before close so another
        // run cannot make it live after the Gateway selected it as a candidate.
        const candidateLease = await options.retention.acquire(targetId);
        if (!candidateLease.granted || (candidateLease.epoch ?? 0) !== epoch) break;
        const result = await rpc(retentionCloseCall(targetId));
        const candidateFence = await options.retention.acquire(targetId);
        const restored = await options.retention.acquire(currentTarget);
        if (
          !candidateFence.granted ||
          (candidateFence.epoch ?? 0) !== epoch ||
          !restored.granted ||
          (restored.epoch ?? 0) !== epoch ||
          !(await fence("browser_retention_cleanup")) ||
          epoch !== coordination.epoch() ||
          currentTarget !== coordination.tabId()
        )
          break;
        // An exact "missing" receipt also completes cleanup: the target was already gone, often
        // because a previous close succeeded but its acknowledgement lost the network race.
        if (parseRetentionReceipt(result, targetId)) closed.push(targetId);
      } catch (error) {
        log(`mcp-proxy: retained target ${targetId} was not closed: ${String(error)}`);
        if (currentTarget) await options.retention.acquire(currentTarget).catch(() => undefined);
        break;
      }
    }
    if (closed.length > 0) {
      try {
        await options.retention.closed(closed);
      } catch (error) {
        // A later cleanup may see already-missing IDs; close is idempotent and the Gateway keeps
        // the audit conservative when this acknowledgement cannot be recorded.
        log(`mcp-proxy: retention close acknowledgement failed: ${String(error)}`);
      }
    }
  }

  async function fence(
    toolName: string | undefined,
    parentSpanId?: string,
    prepareScreenshot = false,
  ): Promise<boolean> {
    return (await fenceStatus(toolName, parentSpanId, prepareScreenshot)) === "ok";
  }

  /**
   * `slow` means screenshot preparation got no answer within the capture bound. The screenshot
   * is best effort, so that skips the capture and keeps the session; a session ended here made
   * every later fence fail and discarded the action's own result as a control change.
   */
  async function fenceStatus(
    toolName: string | undefined,
    parentSpanId?: string,
    prepareScreenshot = false,
  ): Promise<"ok" | "denied" | "slow"> {
    let slow = false;
    const bounded = (call: BrowserCall) =>
      rpcWithTimeout(call, captureTimeoutMs, false).catch((error: unknown) => {
        if (error instanceof RpcTimeoutError) slow = true;
        throw error;
      });
    const ok = await observed("browser_fence", toolName, parentSpanId, () => {
      if (!coordination) return Promise.resolve(true);
      return prepareScreenshot && coordination.prepareCapture
        ? coordination.prepareCapture(bounded)
        : coordination.canCapture(rpc);
    });
    return ok ? "ok" : slow ? "slow" : "denied";
  }

  async function writeCaptureFile(dir: string, action: number, file: unknown): Promise<void> {
    const target = path.join(dir, screenshotFileName(action));
    const temp = path.join(dir, `.${screenshotFileName(action)}.tmp`);
    await mkdir(dir, { recursive: true });
    await writeFile(temp, JSON.stringify(file));
    await rename(temp, target);
  }

  async function handleFromChild(line: string, msg: JsonRpcMessage | undefined): Promise<void> {
    if (msg === undefined || msg.id === undefined) {
      toUpstream(line);
      return;
    }
    const call = calls.get(String(msg.id));
    if (call === undefined) {
      toUpstream(line);
      return;
    }
    calls.delete(String(msg.id));
    if (isPageChangingBrowserTool(call.name)) {
      pageChangingCount += 1;
      if (screenshotDir !== undefined && pageChangingCount <= SCREENSHOT_MAX_PER_RUN) {
        await capture(pageChangingCount, call.name, screenshotDir);
      }
    }
    let result = call.name === "browser_tabs" ? stripTabIdentity(msg.result) : msg.result;
    let diagnostic: string | undefined;
    if (visionFallback?.observe(call, result)) {
      const image = await captureForVisionFallback(call.name);
      if (image) {
        result = appendResultImage(result, image);
        diagnostic =
          "[Deskmates host diagnostic] Two matching target lookups failed. A fresh screenshot is attached for visual inspection. The failed action was not retried.";
      } else {
        diagnostic =
          "[Deskmates host diagnostic] Two matching target lookups failed, but a fresh screenshot could not be safely attached. The failed action was not retried.";
      }
    }
    let outgoing = withheld(wrapResultMessage({ ...msg, result }, currentOrigin));
    if (diagnostic)
      outgoing = { ...outgoing, result: appendResultText(outgoing.result, diagnostic) };
    toUpstream(JSON.stringify(outgoing));
  }

  async function captureForVisionFallback(
    toolName: string,
  ): Promise<{ data: string; mimeType: string } | undefined> {
    try {
      if (coordination && !(await fence(toolName, undefined, true))) return undefined;
      const epoch = coordination?.epoch();
      const target = coordination?.tabId();
      const result = await rpcWithTimeout(
        { name: SCREENSHOT_TOOL, arguments: SCREENSHOT_ARGS },
        captureTimeoutMs,
      );
      if (
        coordination &&
        (!(await fence(toolName)) ||
          epoch !== coordination.epoch() ||
          target !== coordination.tabId())
      )
        return undefined;
      const image = findImage({ result });
      if (!image || Buffer.from(image.data, "base64").length > SCREENSHOT_MAX_BYTES)
        return undefined;
      return image;
    } catch (error) {
      log(`mcp-proxy: vision fallback screenshot unavailable: ${String(error)}`);
      return undefined;
    }
  }

  /**
   * Take capture `action` and write it. Never throws and never rejects: a failure costs the tool
   * result a short delay and a line on stderr, nothing more.
   */
  async function capture(action: number, toolName: string, dir: string): Promise<void> {
    const captureSpan = startSpan("browser_capture", toolName);
    let outcome: TimingOutcome = "ok";
    try {
      const prepared = coordination ? await fenceStatus(toolName, captureSpan?.spanId, true) : "ok";
      if (prepared !== "ok") {
        outcome = "error";
        await writeSkipped(
          action,
          toolName,
          prepared === "slow"
            ? `Screenshot capture skipped: the browser did not answer capture preparation within ${captureTimeoutMs} ms`
            : "Browser capture paused: lease unavailable or human takeover",
        );
        return;
      }
      const captureEpoch = coordination?.epoch();
      const id = `${CAPTURE_ID_PREFIX}${action}`;
      const captureRpcSpan = startSpan("browser_capture_rpc", toolName, captureSpan?.spanId);
      const response = await new Promise<JsonRpcMessage | undefined>((resolve) => {
        // Deliberately not `unref`ed: while a capture is outstanding it is the only thing the
        // tool result is waiting on, and an unreferenced timer would let Node decide the event
        // loop is idle and exit with the result still unwritten.
        const timer = setTimeout(() => {
          captureWaiters.delete(id);
          resolve(undefined);
        }, captureTimeoutMs);
        captureWaiters.set(id, (m) => {
          clearTimeout(timer);
          captureWaiters.delete(id);
          resolve(m);
        });
        toChild(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: { name: SCREENSHOT_TOOL, arguments: SCREENSHOT_ARGS },
          }),
        );
      });
      try {
        captureRpcSpan?.end(response === undefined ? "error" : "ok");
      } catch {}
      if (response === undefined) {
        outcome = "error";
        const reason = `Screenshot capture never answered within ${captureTimeoutMs} ms`;
        log(`mcp-proxy: screenshot ${action} never answered (bound ${captureTimeoutMs} ms)`);
        await writeSkipped(action, toolName, reason);
        return;
      }
      if (
        coordination &&
        (!(await fence(toolName, captureSpan?.spanId)) || captureEpoch !== coordination.epoch())
      ) {
        outcome = "error";
        await writeSkipped(action, toolName, "Browser control changed during capture");
        return;
      }
      const image = findImage(response);
      if (image === undefined) {
        outcome = "error";
        log(`mcp-proxy: screenshot ${action} carried no image`);
        await writeSkipped(action, toolName, "Screenshot capture response carried no image");
        return;
      }
      const bytes = Buffer.from(image.data, "base64").length;
      if (bytes > SCREENSHOT_MAX_BYTES) {
        outcome = "error";
        log(`mcp-proxy: screenshot ${action} dropped, ${bytes} bytes over the cap`);
        await writeSkipped(
          action,
          toolName,
          `Screenshot capture was ${bytes} bytes, over the ${SCREENSHOT_MAX_BYTES} byte cap`,
        );
        return;
      }
      const tabId = coordination?.tabId();
      const file: ScreenshotFile = {
        action,
        toolName,
        mimeType: image.mimeType,
        base64: image.data,
        bytes,
        takenAt: now().toISOString(),
        ...(tabId ? { tabId } : {}),
        ...(captureEpoch !== undefined ? { browserEpoch: captureEpoch } : {}),
      };
      // Written to a temporary name and renamed: the run process polls this directory and must
      // never read a half-written file (`parseScreenshotFile` would reject it, and the capture
      // would be lost for good).
      try {
        await writeCaptureFile(dir, action, file);
      } catch (err) {
        outcome = "error";
        log(`mcp-proxy: screenshot ${action} not written: ${String(err)}`);
        // The same filesystem failure may prevent this marker too. `writeSkipped` preserves the
        // stderr fallback and never lets capture bookkeeping fail the browser action.
        await writeSkipped(
          action,
          toolName,
          `Screenshot capture could not be written: ${String(err)}`,
        );
      }
    } catch (error) {
      outcome = childClosed ? "cancelled" : "error";
      throw error;
    } finally {
      try {
        captureSpan?.end(outcome);
      } catch {}
    }
  }

  return new Promise<void>((resolve) => {
    fromChild.on("close", () => {
      childClosed = true;
      coordination?.cancel?.();
      for (const settle of [...rpcWaiters.values()]) settle(undefined);
      // A capture still outstanding will never be answered now; give up on it at once rather
      // than hold the last tool result for the full bound.
      for (const settle of [...captureWaiters.values()]) settle(undefined);
      // Drain what is still queued before the caller treats the session as over. The upstream
      // output is this process's stdout in production and is not closed here.
      Promise.all([queue, dispatchQueue]).then(
        () => resolve(),
        () => resolve(),
      );
    });
  });
}
