// The stdio proxy in front of LCU (ADR-0048 decisions 3 and 5 to 8). It sits between the SDK's MCP
// client and the LCU process and speaks newline-delimited JSON-RPC 2.0 on both sides, like the
// browser's `mcp-proxy`.
//
//  - Surface (decision 3): `tools/list` keeps the model-visible `js` and `js_reset` only; a model
//    call to a host-only tool (`turn_ended`, `js_add_node_module_dir`, ...) is refused here.
//  - Lease and epoch (decision 6, amendment 1 A3): before a call is dispatched the proxy takes the
//    call's shared-screen lease from the Gateway, `shared` for focus-free code and `exclusive` for
//    raw input or anything the scan cannot place, waiting a bounded time while another call holds
//    the screen, and keeps the takeover epoch it was granted; while the call runs it renews the
//    lease, a refused renewal or a new epoch interrupts the call, and its result releases it.
//  - Input record (decision 4 option D, amendment 1 A5): with the image's reader, the raw input
//    events seen while each call was open are counted and reported per call.
//  - Interruption (decision 5): MCP cancellation to LCU, then, after a grace period, the process
//    is killed. The SDK gets an error result starting `desktop_call_interrupted`, effects unknown;
//    nothing is retried. A late upstream result is dropped.
//  - Lifecycle (decision 7): the upstream `initialize` result, its instructions included, and the
//    tool descriptors reach the SDK unchanged. Host identity is the run, attempt and tool-use id.
//    Before `js_reset` and at shutdown the proxy sends `turn_ended` for the turn that ran `js`. A
//    killed LCU is restarted on the next request by replaying the SDK's own `initialize`, and the
//    next result carries a notice to rediscover windows; so does a resumed run's first result.
//  - Content (decision 8): every `text` item is wrapped as untrusted, entity-escaped; `image`
//    items keep their type, or become a notice when the run withholds images; `isError` is kept.
//
// What it is not: a security boundary. LCU's kernel runs as the container account and every bot
// in the workspace has a shell (ADR-0004, ADR-0048 decision 9).

import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { DESKTOP_MODEL_TOOLS, type DesktopLeaseMode } from "@deskmates/contracts";
import { wrapDesktopContent } from "../untrusted.js";
import { withholdResultImages } from "../vision-withhold.js";
import { desktopLeaseMode } from "./desktop-code-effects.js";
import { DESKTOP_INTERRUPTED } from "./desktop-server.js";
import type { InputCounts, InputRecorder } from "./x-input-record.js";

/** Id space for the proxy's own requests to LCU; responses with it are consumed here. */
export const DESKTOP_ID_PREFIX = "deskmates-desktop-";

/** Key under which LCU's relays pass the host's session and turn (LCU `adapters/claude.mjs`). */
export const TURN_METADATA_KEY = "x-codex-turn-metadata";

/** Where Claude Code puts a call's tool-use id in `tools/call` metadata. */
const TOOL_USE_META_KEY = "claudecode/toolUseId";

export const REDISCOVER_NOTICE =
  "Harness notice: this desktop session is new (a resumed run or a restarted desktop process). " +
  "Window bindings, handles and REPL variables from earlier calls are gone; list and bind the " +
  "windows again before acting.";

export interface DesktopChild {
  stdin: Writable;
  stdout: Readable;
  kill(): void;
}

/** What a lease request answers. */
export interface DesktopLease {
  granted: boolean;
  epoch?: number;
  waitMessage?: string;
  /** Another call holds or waits for the screen, so a retry may succeed. */
  contended?: boolean;
}

export interface DesktopLock {
  /** Take the call's shared-screen lease for a dispatch; a human holder answers not granted. */
  acquire(callId: string, mode: DesktopLeaseMode): Promise<DesktopLease>;
  renew(callId: string): Promise<{ granted: boolean; epoch?: number }>;
  release?(callId: string): Promise<unknown>;
}

/** One call's input record (A5), reported when the call ends. */
export type DesktopInputRecord = InputCounts & {
  toolUseId: string;
  tool: string;
  mode: DesktopLeaseMode;
};

export interface DesktopProxyOptions {
  /** Starts a fresh LCU process; called at start and after a kill. */
  spawn(): DesktopChild;
  /** Absent in a standalone run (no Gateway): calls dispatch without the lock. */
  lock?: DesktopLock;
  runId: string;
  attempt: number;
  /** The first result of a resumed run carries the rediscovery notice. */
  resumed?: boolean;
  withholdImages?: boolean;
  renewMs?: number;
  graceMs?: number;
  /** Longest the shutdown waits for `turn_ended`. */
  shutdownMs?: number;
  /** A3: how often a contended lease is asked again, and for how long in all. */
  contentionPollMs?: number;
  contentionWaitMs?: number;
  /** A5: counts the image's raw input events per call; absent when the image has no reader. */
  recorder?: InputRecorder;
  onInputRecord?: (record: DesktopInputRecord) => void;
  log?: (message: string) => void;
}

interface JsonRpc {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

interface Pending {
  method: string;
  tool?: string;
  /** The shared-screen lease of a `tools/call` (A3). */
  callId?: string | undefined;
  mode?: DesktopLeaseMode;
  toolUseId?: string;
  epoch?: number;
  renew?: ReturnType<typeof setInterval>;
  interrupted?: string;
  grace?: ReturnType<typeof setTimeout>;
  /** The SDK cancelled it itself: no answer is owed. */
  cancelledByClient?: boolean;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function errorResult(text: string): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError: true };
}

/** Wrap text items as untrusted desktop content, keep everything else, then withhold images. */
export function desktopResultForModel(result: unknown, withholdImages: boolean): unknown {
  const r = record(result);
  if (!Array.isArray(r.content)) return result;
  const content = r.content.map((item: unknown) => {
    const block = record(item);
    return block.type === "text" && typeof block.text === "string"
      ? { ...block, text: wrapDesktopContent(block.text) }
      : item;
  });
  const wrapped = { ...r, content };
  return withholdImages ? withholdResultImages(wrapped) : wrapped;
}

export class DesktopProxy {
  private child: DesktopChild | undefined;
  private initialize: JsonRpc | undefined;
  private initialized: JsonRpc | undefined;
  private readonly pending = new Map<string, Pending>();
  private ownSeq = 0;
  private generation = 0;
  private ranJs = false;
  private notice: boolean;
  private toolUseSeq = 0;
  private closed = false;
  /** Resolves the proxy's own requests (turn_ended, a replayed initialize). */
  private readonly own = new Map<string, (message: JsonRpc) => void>();

  constructor(
    private readonly upstream: Writable,
    private readonly opts: DesktopProxyOptions,
  ) {
    this.notice = opts.resumed === true;
  }

  private log(message: string): void {
    (this.opts.log ?? ((m) => process.stderr.write(`desktop-proxy: ${m}\n`)))(message);
  }

  private toSdk(message: JsonRpc): void {
    if (!this.upstream.destroyed) this.upstream.write(`${JSON.stringify(message)}\n`);
  }

  private toChild(message: JsonRpc): void {
    const child = this.ensureChild();
    if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private sessionId(): string {
    return `${this.opts.runId}/${this.opts.attempt}`;
  }

  private turnId(): string {
    return `${this.sessionId()}/${this.generation}`;
  }

  /** Start the child, and after a restart replay the SDK's own handshake to it. */
  private ensureChild(): DesktopChild {
    if (this.child) return this.child;
    const child = this.opts.spawn();
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.fromChild(child, line));
    child.stdout.on("close", () => this.childGone(child));
    if (this.initialize) {
      const id = this.ownId();
      this.own.set(id, () => undefined);
      child.stdin.write(`${JSON.stringify({ ...this.initialize, id })}\n`);
      if (this.initialized) child.stdin.write(`${JSON.stringify(this.initialized)}\n`);
    }
    return child;
  }

  private ownId(): string {
    return `${DESKTOP_ID_PREFIX}${++this.ownSeq}`;
  }

  /** Ask LCU something on the proxy's own behalf; resolves on its answer or after `ms`. */
  private ownRequest(method: string, params: unknown, ms: number): Promise<void> {
    if (!this.child) return Promise.resolve();
    const id = this.ownId();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.own.delete(id);
        resolve();
      }, ms);
      this.own.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      this.toChild({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** `turn_ended` for the current turn, if it ran `js` (LCU's host lifecycle). */
  private async endTurn(hook: "Stop" | "Interrupt", ms: number): Promise<void> {
    if (!this.ranJs) return;
    this.ranJs = false;
    await this.ownRequest(
      "tools/call",
      {
        name: "turn_ended",
        arguments: { hook_event_name: hook, session_id: this.sessionId(), turn_id: this.turnId() },
      },
      ms,
    );
  }

  private childGone(child: DesktopChild): void {
    if (this.child !== child) return;
    this.child = undefined;
    this.generation++;
    this.ranJs = false;
    if (this.closed) return;
    this.notice = true;
    for (const [id, p] of this.pending) {
      this.finish(id, p);
      if (!p.cancelledByClient && p.method === "tools/call")
        this.toSdk({
          jsonrpc: "2.0",
          id: JSON.parse(id),
          result: errorResult(
            `${DESKTOP_INTERRUPTED}: ${p.interrupted ?? "the desktop process exited"}; effects unknown, nothing was retried`,
          ),
        });
      else if (!p.cancelledByClient)
        this.toSdk({
          jsonrpc: "2.0",
          id: JSON.parse(id),
          error: { code: -32603, message: "desktop process exited" },
        });
    }
    this.pending.clear();
  }

  /** A call is over: stop its timers, release its lease and report its input record. */
  private finish(id: string, p: Pending): void {
    if (p.renew) clearInterval(p.renew);
    if (p.grace) clearTimeout(p.grace);
    const counts = p.mode ? this.opts.recorder?.end(id) : undefined;
    if (counts && p.tool && p.mode && p.toolUseId)
      this.opts.onInputRecord?.({ toolUseId: p.toolUseId, tool: p.tool, mode: p.mode, ...counts });
    if (p.callId !== undefined) {
      const callId = p.callId;
      p.callId = undefined;
      void this.opts.lock?.release?.(callId).catch(() => undefined);
    }
  }

  /**
   * A3: the call's lease, asked again while another call holds or waits for the screen, for up
   * to `contentionWaitMs`. A human hold is answered at once.
   */
  private async lease(
    lock: DesktopLock,
    callId: string,
    mode: DesktopLeaseMode,
  ): Promise<DesktopLease> {
    const ask = (): Promise<DesktopLease> =>
      lock.acquire(callId, mode).catch((): DesktopLease => ({ granted: false }));
    const poll = this.opts.contentionPollMs ?? 250;
    const deadline = Date.now() + (this.opts.contentionWaitMs ?? 30_000);
    let answer = await ask();
    while (!answer.granted && answer.contended === true && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, poll));
      answer = await ask();
    }
    if (!answer.granted) void lock.release?.(callId).catch(() => undefined);
    return answer;
  }

  /** Cancel a call: MCP cancellation, then the kill after the grace period (decision 5). */
  private interrupt(key: string, reason: string): void {
    const p = this.pending.get(key);
    if (!p || p.interrupted) return;
    p.interrupted = reason;
    if (p.renew) clearInterval(p.renew);
    this.log(`interrupting call ${key}: ${reason}`);
    this.toChild({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: JSON.parse(key), reason },
    });
    const child = this.child;
    p.grace = setTimeout(() => {
      if (this.pending.get(key) === p && child && this.child === child) {
        this.log("killing the desktop process after the grace period");
        child.kill();
        this.childGone(child);
      }
    }, this.opts.graceMs ?? 2000);
  }

  async fromSdk(line: string): Promise<void> {
    let message: JsonRpc;
    try {
      message = JSON.parse(line) as JsonRpc;
    } catch {
      return;
    }
    const method = typeof message.method === "string" ? message.method : undefined;
    const hasId = message.id !== undefined && message.id !== null;
    if (method === "initialize" && hasId) this.initialize = { ...message };
    if (method === "notifications/initialized") this.initialized = message;
    if (method === "notifications/cancelled") {
      const key = JSON.stringify(record(message.params).requestId);
      const p = this.pending.get(key);
      if (p) {
        p.cancelledByClient = true;
        this.interrupt(key, "cancelled by the run");
      }
      return;
    }
    if (!method || !hasId) {
      // A response to a request LCU made, or a notification: pass through.
      this.toChild(message);
      return;
    }
    const key = JSON.stringify(message.id);
    if (method !== "tools/call") {
      this.pending.set(key, { method });
      this.toChild(message);
      return;
    }
    const params = record(message.params);
    const tool = typeof params.name === "string" ? params.name : "";
    if (!DESKTOP_MODEL_TOOLS.includes(tool)) {
      this.toSdk({
        jsonrpc: "2.0",
        id: message.id,
        result: errorResult(
          `${tool || "this tool"} is host-only and cannot be called by the model`,
        ),
      });
      return;
    }
    let epoch: number | undefined;
    const mode = desktopLeaseMode(tool, record(params.arguments));
    const callId = `${this.opts.attempt}:${key}`;
    if (this.opts.lock) {
      const lock = await this.lease(this.opts.lock, callId, mode);
      if (!lock.granted) {
        const wait = lock.waitMessage ? lock.waitMessage : undefined;
        this.toSdk({
          jsonrpc: "2.0",
          id: message.id,
          result: errorResult(
            wait ?? "The workspace screen is held; nothing was sent to the desktop.",
          ),
        });
        return;
      }
      epoch = lock.epoch ?? 0;
    }
    if (tool === "js_reset") {
      await this.endTurn("Stop", this.opts.shutdownMs ?? 2000);
      this.generation++;
    }
    const meta = record(params._meta);
    const toolUseId =
      typeof meta[TOOL_USE_META_KEY] === "string"
        ? (meta[TOOL_USE_META_KEY] as string)
        : `${this.sessionId()}#${++this.toolUseSeq}`;
    const forwarded: JsonRpc = {
      ...message,
      params: {
        ...params,
        _meta: {
          ...meta,
          [TURN_METADATA_KEY]: {
            session_id: this.sessionId(),
            turn_id: this.turnId(),
            tool_use_id: toolUseId,
          },
        },
      },
    };
    const p: Pending = {
      method,
      tool,
      mode,
      toolUseId,
      ...(this.opts.lock ? { callId } : {}),
      ...(epoch === undefined ? {} : { epoch }),
    };
    this.pending.set(key, p);
    this.opts.recorder?.begin(key);
    if (tool === "js") this.ranJs = true;
    const lock = this.opts.lock;
    if (lock && epoch !== undefined) {
      p.renew = setInterval(() => {
        lock
          .renew(callId)
          .then((renewed) => {
            if (!renewed.granted) this.interrupt(key, "a human took over the workspace");
            else if ((renewed.epoch ?? 0) !== epoch)
              this.interrupt(key, "control of the workspace changed hands");
          })
          .catch(() => this.interrupt(key, "the workspace lock could not be renewed"));
      }, this.opts.renewMs ?? 2000);
    }
    this.toChild(forwarded);
  }

  private fromChild(child: DesktopChild, line: string): void {
    if (this.child !== child) return;
    let message: JsonRpc;
    try {
      message = JSON.parse(line) as JsonRpc;
    } catch {
      return;
    }
    const isResponse =
      message.method === undefined && (message.result !== undefined || message.error !== undefined);
    if (isResponse && typeof message.id === "string" && message.id.startsWith(DESKTOP_ID_PREFIX)) {
      const done = this.own.get(message.id);
      this.own.delete(message.id);
      done?.(message);
      return;
    }
    if (!isResponse) {
      // A request or notification from LCU (elicitation, progress, logging): pass through.
      this.toSdk(message);
      return;
    }
    const key = JSON.stringify(message.id);
    const p = this.pending.get(key);
    if (!p) return;
    this.pending.delete(key);
    this.finish(key, p);
    if (p.cancelledByClient) return;
    if (p.interrupted) {
      this.toSdk({
        jsonrpc: "2.0",
        id: message.id,
        result: errorResult(
          `${DESKTOP_INTERRUPTED}: ${p.interrupted}; effects unknown, nothing was retried`,
        ),
      });
      return;
    }
    if (p.method === "tools/list" && message.result !== undefined) {
      const result = record(message.result);
      const tools = Array.isArray(result.tools) ? result.tools : [];
      this.toSdk({
        ...message,
        result: {
          ...result,
          tools: tools.filter((t) => DESKTOP_MODEL_TOOLS.includes(String(record(t).name))),
        },
      });
      return;
    }
    if (p.method === "tools/call" && message.result !== undefined) {
      let result = desktopResultForModel(message.result, this.opts.withholdImages === true);
      if (this.notice) {
        this.notice = false;
        const r = record(result);
        result = {
          ...r,
          content: [
            { type: "text", text: REDISCOVER_NOTICE },
            ...(Array.isArray(r.content) ? r.content : []),
          ],
        };
      }
      this.toSdk({ ...message, result });
      return;
    }
    this.toSdk(message);
  }

  /** The SDK closed its side: end the turn, then stop LCU. */
  async close(): Promise<void> {
    await this.endTurn("Stop", this.opts.shutdownMs ?? 2000);
    this.closed = true;
    for (const [id, p] of this.pending) this.finish(id, p);
    const child = this.child;
    this.child = undefined;
    if (child) {
      child.stdin.end();
      child.kill();
    }
  }

  start(): void {
    this.ensureChild();
  }
}

/** Run the proxy over two streams until the SDK closes its side. */
export async function runDesktopProxy(
  upstream: { input: Readable; output: Writable },
  opts: DesktopProxyOptions,
): Promise<void> {
  const proxy = new DesktopProxy(upstream.output, opts);
  proxy.start();
  let chain = Promise.resolve();
  const lines = createInterface({ input: upstream.input });
  lines.on("line", (line) => {
    // In order: a call waits for its lock before the next line is handled.
    chain = chain.then(() => proxy.fromSdk(line)).catch(() => undefined);
  });
  await new Promise<void>((resolve) => lines.once("close", () => resolve()));
  await chain;
  await proxy.close();
}
