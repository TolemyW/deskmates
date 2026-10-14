// Fixtures and doubles for the web tests: sample API rows, a scripted `fetch`, and a
// controllable `EventSource`. Test-only; nothing under src/ outside *.test.* imports this.

import {
  APPROVAL_ATTACHMENT_MIME,
  type Approval,
  type ApprovalId,
  type ApprovalRule,
  type BotDefinition,
  type BotId,
  type BrowserLock,
  type MessageId,
  type RunEvent,
  type RunId,
  type RunUsage,
  type ScreenAccess,
  type Task,
  type Thread,
  type ThreadId,
  type ThreadMessage,
  type Workspace,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayEvent, NamedThreadMember, RunView, WorkspaceView } from "../api/types.js";

export const WS_ID = "ws_1" as WorkspaceId;
export const BOT_ID = "bot_1" as BotId;
export const THREAD_ID = "thr_1" as ThreadId;
export const RUN_ID = "run_1" as RunId;
export const APPROVAL_ID = "apr_1" as ApprovalId;
const T0 = "2026-09-21T10:00:00.000Z";

export const workspace: Workspace = {
  id: WS_ID,
  name: "default",
  sandboxProvider: "docker",
  status: "ready",
  egressAllowlist: ["example.com"],
  createdAt: T0,
};

export function task(extra: Partial<Task> = {}): Task {
  return {
    id: "task_1",
    workspaceId: WS_ID,
    title: "Prepare the weekly report",
    description: "Summarize the workspace findings.",
    ownerBotId: null,
    status: "planned",
    blockedReason: "",
    nextAction: "",
    threadIds: [],
    runIds: [],
    artifacts: [],
    version: 1,
    createdAt: T0,
    updatedAt: T0,
    deliveredAt: null,
    deliveredBy: null,
    outputSchema: null,
    output: null,
    acceptedAt: null,
    acceptedBy: null,
    scopeVersion: 1,
    schedule: null,
    ...extra,
  };
}

export const bot: BotDefinition = {
  id: BOT_ID,
  name: "ops",
  role: "operator",
  workspaceId: WS_ID,
  soulVersion: 1,
  connectors: [],
  messageAllowlist: [],
  cron: [],
  createdAt: T0,
};

/** A one-use screen-proxy ticket, what the open-screen and screen-access routes return. */
export function screenTicket(extra: Partial<ScreenAccess> = {}): ScreenAccess {
  return {
    accessId: "acc_1",
    path: "/api/desktop-stream",
    protocol: "deskmates-screen.test",
    mode: "control",
    ...extra,
  };
}

/** The human hold on the workspace browser: what `GET /api/workspaces/:id` returns as `browserLock`. */
export function browserLock(extra: Partial<BrowserLock> = {}): BrowserLock {
  return {
    workspaceId: WS_ID,
    holderKind: "human",
    acquiredAt: T0,
    expiresAt: "2026-09-21T11:00:00.000Z",
    ...extra,
  };
}

export function workspaceView(extra: Partial<WorkspaceView> = {}): WorkspaceView {
  return { workspace, bots: [bot], browserLock: null, takeoverScreen: true, ...extra };
}

export const thread: Thread = {
  id: THREAD_ID,
  workspaceId: WS_ID,
  kind: "chat",
  channel: "web",
  title: "Morning check",
  turnBudget: 8,
  status: "active",
  createdAt: T0,
  updatedAt: T0,
};

export const members: NamedThreadMember[] = [
  { threadId: THREAD_ID, botId: BOT_ID, lastSeenSeq: 0, joinedAt: T0, name: "ops" },
];

export function message(
  seq: number,
  authorKind: ThreadMessage["authorKind"],
  body: string,
  extra: Partial<ThreadMessage> = {},
): ThreadMessage {
  return {
    id: `msg_${seq}`,
    threadId: THREAD_ID,
    seq,
    authorKind,
    authorId: authorKind === "bot" ? BOT_ID : authorKind === "human" ? "operator" : "",
    body,
    attachments: [],
    mentions: [],
    relayCount: 0,
    ts: T0,
    ...extra,
  } as ThreadMessage;
}

export function run(extra: Partial<RunView> = {}): RunView {
  return {
    id: RUN_ID,
    botId: BOT_ID,
    threadId: THREAD_ID,
    lane: "interactive",
    triggerKind: "thread_message",
    triggerRef: "msg_1",
    status: "queued",
    attempt: 1,
    createdAt: T0,
    config: {},
    ...extra,
  };
}

export function approval(extra: Partial<Approval> = {}): Approval {
  return {
    id: APPROVAL_ID,
    runId: RUN_ID,
    botId: BOT_ID,
    threadId: THREAD_ID,
    messageId: "msg_2" as MessageId,
    action: {
      toolName: "browser_click",
      input: { element: "Submit order" },
      targetOrigin: "https://shop.example.com",
      argumentSummary: "click Submit order",
    },
    riskLevel: "L2",
    instruction: "order the widgets",
    waitMode: "live",
    createdAt: T0,
    ...extra,
  };
}

/** The three-line body the Gateway posts with the request, as ADR-0002 amendment 2 describes. */
export function approvalBody(a: Approval = approval()): string {
  return [
    `Approval needed: ${a.action.toolName}${a.action.targetOrigin ? ` on ${a.action.targetOrigin}` : ""}`,
    `Arguments: ${a.action.argumentSummary ?? ""}`,
    `Instruction: ${a.instruction ?? ""}`,
  ].join("\n");
}

/** A `system` thread message carrying the approval attachment: the request, or its decision echo. */
export function approvalMessage(
  seq: number,
  body: string,
  approvalId: ApprovalId = APPROVAL_ID,
): ThreadMessage {
  return message(seq, "system", body, {
    attachments: [{ name: "approval", mimeType: APPROVAL_ATTACHMENT_MIME, ref: approvalId }],
  });
}

export function approvalRule(extra: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: "rul_1",
    botId: BOT_ID,
    matcher: { toolName: "browser_click", targetOrigin: "https://shop.example.com" },
    decision: "allow_always",
    createdFromApprovalId: APPROVAL_ID,
    createdBy: "human:operator",
    createdAt: T0,
    ...extra,
  };
}

export function runEvent(
  seq: number,
  kind: RunEvent["kind"],
  payload: RunEvent["payload"],
): RunEvent {
  return { runId: RUN_ID, seq, kind, payload, ts: T0 };
}

export function usage(model: string, costUsd: number | null): RunUsage {
  return {
    runId: RUN_ID,
    model,
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUsd,
  };
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

export type RouteTable = Record<
  string,
  unknown | ((call: RecordedCall) => unknown | Promise<unknown>)
>;

/**
 * A `fetch` double keyed by `"METHOD /path"` (query string included). Unknown routes return
 * 404 in the Gateway's error shape; a value that is an `Error` returns 400 with its message.
 */
export function fakeFetch(routes: RouteTable): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const call = { method, path: url, body };
    calls.push(call);
    const key = `${method} ${url}`;
    if (!(key in routes)) {
      if (method === "GET" && /^\/api\/threads\/[^/]+\/activity$/.test(url))
        return json(200, { handoffs: [] });
      return json(404, { code: "not_found", message: `no route ${key}`, details: {} });
    }
    const entry = routes[key];
    const value =
      typeof entry === "function"
        ? await (entry as (c: RecordedCall) => unknown | Promise<unknown>)(call)
        : entry;
    if (value instanceof Error) {
      return json(400, { code: "validation", message: value.message, details: {} });
    }
    return json(method === "POST" ? 201 : 200, value);
  };
  return { fetch: impl as typeof fetch, calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A controllable EventSource: tests call `emit` on the most recent instance. */
export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly url: string;
  readyState = 0;
  onopen: ((e: Event) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<(e: Event) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  static reset(): void {
    FakeEventSource.instances = [];
  }

  static get last(): FakeEventSource {
    const es = FakeEventSource.instances.at(-1);
    if (!es) throw new Error("no EventSource opened");
    return es;
  }

  /** The most recent stream opened for exactly `url`; a screen may hold more than one. */
  static forUrl(url: string): FakeEventSource {
    const es = [...FakeEventSource.instances].reverse().find((i) => i.url === url);
    if (!es) throw new Error(`no EventSource opened for ${url}`);
    return es;
  }

  addEventListener(type: string, fn: (e: Event) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn);
  }

  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  /** Deliver one frame the way the Gateway formats it: `event: <type>` with JSON `data`. */
  emit(event: GatewayEvent): void {
    const e = new MessageEvent(event.type, { data: JSON.stringify(event) });
    for (const fn of this.listeners.get(event.type) ?? []) fn(e);
  }

  /** Simulate the browser giving up: readyState CLOSED, then `error`. */
  fail(): void {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }

  /**
   * Simulate a transient drop the browser retries by itself: readyState CONNECTING, then `error`.
   * The same instance comes back with `open()`, having missed whatever was sent meanwhile.
   */
  drop(): void {
    this.readyState = 0;
    this.onerror?.(new Event("error"));
  }

  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
}

export function installFakeEventSource(): void {
  FakeEventSource.reset();
  // The screens read `globalThis.EventSource` at subscribe time; jsdom does not provide one.
  (globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;
}
