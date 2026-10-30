// The demo Gateway's shared in-memory state: the records several features read and write
// (workspaces, bots, threads, messages, runs, approvals, rules, learned memory, tasks, files),
// the helpers that create them the way the Gateway would, and the id and time helpers. A record
// only one feature uses lives in that feature's own store (`DemoState.store`), declared in its
// `src/features/<feature>/demo.ts`.

import type {
  Approval,
  ApprovalId,
  ApprovalRule,
  BotDefinition,
  BotId,
  MemoryEntry,
  MemoryVersion,
  MessageId,
  OperatorConfig,
  RunEvent,
  RunId,
  RunStatus,
  RunSummary,
  RunUsage,
  Task,
  Thread,
  ThreadId,
  ThreadMessage,
  ThreadSummary,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import { CHAT_PREVIEW_MAX, messageExcerpt } from "@deskmates/contracts";
import type { GatewayEvent, NamedThreadMember, RunView } from "../api/types.js";

export type Emit = (event: GatewayEvent) => void;

/** Which cost-alert state the demo starts in; chosen with `?costAlerts=` on the demo page. */
export type CostAlertFixture = "empty" | "populated" | "failure";

export interface LearnedEntry extends MemoryEntry {
  live: boolean;
  episodeId?: string;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// One counter per page load, shared by every record kind: ids follow the seeding order, so a
// seed step that moves changes the ids after it.
let counter = 0;
export function id(prefix: string): string {
  counter += 1;
  return `${prefix}_${counter.toString(36).padStart(4, "0")}`;
}

/** Tools whose calls the sidecar tiers as reversible writes; the rest of the demo's are reads. */
const WRITE_TOOLS = new Set(["Bash", "Write", "Edit"]);

/**
 * A seed or script writes a tool event the short way (`{ tool, input }`, `{ tool, output }`);
 * the ledger's shape is the sidecar's (`toolName`, `toolUseId`, `riskLevel`, `input`; a result
 * carries its call's `toolUseId`, `content` and `isError`). The screens read only the ledger's
 * shape, so the demo must produce it, with a result paired to the open call before it.
 */
export function ledgerPayload(
  kind: RunEvent["kind"],
  payload: Record<string, unknown>,
  earlier: readonly RunEvent[],
): Record<string, unknown> {
  if (kind === "tool_call" && typeof payload.tool === "string" && payload.toolName === undefined) {
    const { tool, input, ...rest } = payload;
    return {
      toolName: tool,
      toolUseId: `tu_${earlier.length + 1}`,
      riskLevel: WRITE_TOOLS.has(tool) ? "L1" : "L0",
      input: input ?? {},
      ...rest,
    };
  }
  if (kind === "tool_result" && payload.toolUseId === undefined) {
    const answered = new Set(
      earlier.filter((e) => e.kind === "tool_result").map((e) => e.payload.toolUseId),
    );
    const call = [...earlier]
      .reverse()
      .find((e) => e.kind === "tool_call" && !answered.has(e.payload.toolUseId));
    const { tool: _tool, output, ...rest } = payload;
    return {
      ...(call ? { toolUseId: call.payload.toolUseId } : {}),
      content: output ?? payload.content ?? "",
      isError: payload.isError === true,
      ...rest,
    };
  }
  return payload;
}

export function minutesAgo(minutes: number, base = Date.now()): string {
  return new Date(base - minutes * 60_000).toISOString();
}

/** Thrown inside a scripted run the operator cancelled, so its script ends at the next step. */
export class DemoRunCancelled extends Error {}

export function ignoreCancelled(err: unknown): void {
  if (!(err instanceof DemoRunCancelled)) throw err;
}

export function summary(reply: string, extra: Partial<RunSummary> = {}): RunSummary {
  return {
    done: "answered",
    filesChanged: [],
    sitesVisited: [],
    pendingApprovals: [],
    memorySuggestions: [],
    reply,
    ...extra,
  };
}

const PRICE = { input: 3, output: 15, cacheRead: 0.3 };

export function priced(u: Omit<RunUsage, "costUsd">): RunUsage {
  return {
    ...u,
    costUsd:
      (u.inputTokens * PRICE.input +
        u.outputTokens * PRICE.output +
        u.cacheReadTokens * PRICE.cacheRead) /
      1_000_000,
  };
}

export class DemoState {
  readonly workspaces: Workspace[] = [];
  readonly bots: BotDefinition[] = [];
  readonly threads: Thread[] = [];
  readonly tasks = new Map<string, Task>();
  readonly members = new Map<ThreadId, BotId[]>();
  /** Canonical private chats (ADR-0024 decision 6); `null` once the inbox became a group. */
  readonly privateChats = new Map<BotId, ThreadId | null>();
  readonly messages = new Map<ThreadId, ThreadMessage[]>();
  readonly runs = new Map<RunId, RunView>();
  readonly events = new Map<RunId, RunEvent[]>();
  readonly usage = new Map<RunId, RunUsage[]>();
  readonly approvals = new Map<ApprovalId, Approval>();
  readonly rules: ApprovalRule[] = [];
  readonly souls = new Map<BotId, { body: string; version: string }>();
  readonly notes = new Map<BotId, { body: string; version: string }>();
  readonly memory: LearnedEntry[] = [];
  readonly versions = new Map<string, MemoryVersion[]>();
  readonly files = new Map<string, string>();
  /** Whether a human holds the workspace browser (takeover); read by the workspace detail. */
  humanHolds = false;
  private readonly stores = new Map<string, unknown>();

  constructor(
    readonly emit: Emit,
    readonly costAlertFixture: CostAlertFixture = "empty",
  ) {}

  /**
   * A feature's private records, created on first use. Each feature calls it through one
   * module-level accessor so the key and the initial value stay in one place.
   */
  store<T>(key: string, init: () => T): T {
    if (!this.stores.has(key)) this.stores.set(key, init());
    return this.stores.get(key) as T;
  }

  config(): OperatorConfig {
    return {
      defaultModel: "demo-large",
      cheapModel: "demo-small",
      release: "demo",
      cronTimeZone: "UTC",
      analyticsUrl: null,
      models: [
        { model: "demo-large", upstream: "default" },
        { model: "demo-local", upstream: "local" },
        { model: "demo-small", upstream: "default" },
      ],
    };
  }

  bot(raw: string | undefined): BotDefinition | undefined {
    const botId = decodeURIComponent(raw ?? "");
    return this.bots.find((b) => b.id === botId);
  }

  thread(raw: string | undefined): Thread | undefined {
    const threadId = decodeURIComponent(raw ?? "");
    return this.threads.find((t) => t.id === threadId);
  }

  namedMembers(threadId: ThreadId): NamedThreadMember[] {
    return (this.members.get(threadId) ?? []).map((botId) => ({
      threadId,
      botId,
      lastSeenSeq: this.messages.get(threadId)?.at(-1)?.seq ?? 0,
      joinedAt: this.threads.find((t) => t.id === threadId)?.createdAt ?? new Date().toISOString(),
      name: this.bots.find((b) => b.id === botId)?.name ?? botId,
    }));
  }

  detail(thread: Thread) {
    return { thread, members: this.namedMembers(thread.id), groupRouting: "owner-v1" as const };
  }

  unbindPrivateChat(threadId: ThreadId): void {
    for (const [botId, bound] of this.privateChats)
      if (bound === threadId) this.privateChats.set(botId, null);
  }

  summarize(thread: Thread): ThreadSummary {
    const last = this.messages.get(thread.id)?.at(-1);
    const privateChatBotId = [...this.privateChats].find(([, bound]) => bound === thread.id)?.[0];
    return {
      ...thread,
      ...(privateChatBotId ? { privateChatBotId } : {}),
      memberIds: this.members.get(thread.id) ?? [],
      ...(last
        ? {
            lastMessage: {
              seq: last.seq,
              authorKind: last.authorKind,
              authorId: last.authorId,
              excerpt: messageExcerpt(last.body, CHAT_PREVIEW_MAX),
              ts: last.ts,
            },
          }
        : {}),
    };
  }

  addWorkspace(name: string, egressAllowlist: string[], at = new Date().toISOString()): Workspace {
    const workspace: Workspace = {
      id: id("ws") as WorkspaceId,
      name,
      sandboxProvider: "docker",
      status: "ready",
      egressAllowlist,
      egressUpdatedAt: at,
      createdAt: at,
    };
    this.workspaces.push(workspace);
    return workspace;
  }

  addBot(
    name: string,
    role: string,
    workspaceId: WorkspaceId,
    soul: string,
    at = new Date().toISOString(),
  ): BotDefinition {
    const bot: BotDefinition = {
      id: id("bot") as BotId,
      name,
      role,
      workspaceId,
      soulVersion: soul ? 1 : 0,
      connectors: [],
      messageAllowlist: [],
      cron: [],
      createdAt: at,
    };
    this.bots.push(bot);
    this.souls.set(bot.id, { body: soul, version: soul ? "v1" : "v0" });
    this.notes.set(bot.id, { body: "", version: "n0" });
    return bot;
  }

  addThread(
    workspaceId: WorkspaceId,
    botIds: BotId[],
    title: string,
    kind: Thread["kind"],
    at = new Date().toISOString(),
  ): Thread {
    const thread: Thread = {
      id: id("thr") as ThreadId,
      workspaceId,
      kind,
      channel: "web",
      title,
      turnBudget: 8,
      status: "active",
      createdAt: at,
      updatedAt: at,
    };
    this.threads.push(thread);
    this.members.set(thread.id, [...botIds]);
    this.messages.set(thread.id, []);
    return thread;
  }

  post(
    thread: Thread,
    authorKind: ThreadMessage["authorKind"],
    authorId: string,
    body: string,
    extra: Partial<ThreadMessage> = {},
  ): ThreadMessage {
    const list = this.messages.get(thread.id) ?? [];
    const names = new Map(this.bots.map((b) => [b.name, b.id]));
    const mentions: ThreadMessage["mentions"] = [...body.matchAll(/(?<![\w@])@([A-Za-z0-9_-]+)/g)]
      .map((m) =>
        m[1] === "everyone"
          ? { kind: "everyone" as const }
          : names.has(m[1] ?? "")
            ? { kind: "bot" as const, botId: names.get(m[1] ?? "") as BotId }
            : undefined,
      )
      .filter((m): m is NonNullable<typeof m> => m !== undefined);
    const message: ThreadMessage = {
      id: id("msg") as MessageId,
      threadId: thread.id,
      seq: (list.at(-1)?.seq ?? 0) + 1,
      authorKind,
      authorId,
      body,
      attachments: [],
      mentions,
      relayCount: 0,
      ts: new Date().toISOString(),
      ...extra,
    };
    list.push(message);
    this.messages.set(thread.id, list);
    thread.updatedAt = message.ts;
    this.emit({ type: "thread_message", threadId: thread.id, message });
    return message;
  }

  newRun(
    bot: BotDefinition,
    threadId: ThreadId | undefined,
    triggerKind: RunView["triggerKind"],
    triggerRef: string,
    lane: RunView["lane"],
    at = new Date().toISOString(),
  ): RunView {
    const run: RunView = {
      id: id("run") as RunId,
      botId: bot.id,
      ...(threadId ? { threadId } : {}),
      lane,
      triggerKind,
      triggerRef,
      status: "queued",
      attempt: 1,
      createdAt: at,
      config: {
        model: bot.model ?? this.config().defaultModel,
        maxTurns: 50,
        groupRouting: "owner-v1",
      },
    };
    this.runs.set(run.id, run);
    this.events.set(run.id, []);
    this.emit({ type: "run_status", ...(threadId ? { threadId } : {}), run: { ...run } });
    return run;
  }

  setStatus(run: RunView, status: RunStatus, extra: Partial<RunView> = {}): void {
    // A cancelled run is final: its script stops here instead of overwriting the cancel.
    if (run.status === "cancelled") throw new DemoRunCancelled();
    Object.assign(run, { status, ...extra });
    if (status === "running" && !run.startedAt) run.startedAt = new Date().toISOString();
    if (["succeeded", "silent", "failed", "cancelled", "stopped"].includes(status))
      run.finishedAt = new Date().toISOString();
    this.emit({
      type: "run_status",
      ...(run.threadId ? { threadId: run.threadId } : {}),
      run: { ...run },
    });
  }

  addEvent(
    run: RunView,
    kind: RunEvent["kind"],
    payload: Record<string, unknown>,
    ts = new Date().toISOString(),
  ): RunEvent {
    if (run.status === "cancelled") throw new DemoRunCancelled();
    const list = this.events.get(run.id) ?? [];
    const event: RunEvent = {
      runId: run.id,
      seq: list.length + 1,
      attempt: run.attempt,
      kind,
      payload: ledgerPayload(kind, payload, list),
      ts,
    };
    list.push(event);
    this.events.set(run.id, list);
    this.emit({ type: "run_event", ...(run.threadId ? { threadId: run.threadId } : {}), event });
    return event;
  }

  recordUsage(run: RunView, input: number, output: number): void {
    this.usage.set(run.id, [
      priced({
        runId: run.id,
        model: String(run.config.model ?? "demo-large"),
        inputTokens: input,
        outputTokens: output,
        cacheReadTokens: Math.round(input * 0.6),
        cacheCreateTokens: 0,
      }),
    ]);
    this.addEvent(run, "turn_usage", {
      model: run.config.model,
      turn: 1,
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: Math.round(input * 0.6),
      cacheCreateTokens: 0,
    });
  }

  addMemory(
    input: Omit<
      LearnedEntry,
      "id" | "workspaceId" | "observedAt" | "validFrom" | "version" | "tombstoned" | "live"
    > & { observedAt?: string },
  ): LearnedEntry {
    const at = input.observedAt ?? new Date().toISOString();
    const entry: LearnedEntry = {
      ...input,
      id: id("mem"),
      workspaceId: this.workspaces[0]?.id as WorkspaceId,
      observedAt: at,
      validFrom: at,
      version: 1,
      tombstoned: false,
      live: true,
    };
    this.memory.push(entry);
    this.pushVersion(entry, "create");
    return entry;
  }

  pushVersion(entry: LearnedEntry, op: MemoryVersion["op"]): void {
    const list = this.versions.get(entry.id) ?? [];
    if (op !== "create") entry.version += 1;
    list.push({
      entryId: entry.id,
      version: entry.version,
      op,
      body: entry.body,
      createdAt: new Date().toISOString(),
      redacted: false,
    } as MemoryVersion);
    this.versions.set(entry.id, list);
  }

  active(): RunView[] {
    return [...this.runs.values()].filter((r) => r.status === "running" || r.status === "queued");
  }
}
