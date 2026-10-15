// Shapes the Gateway HTTP/SSE API returns that are not themselves in `@deskmates/contracts`:
// the `Run` response carries ledger-only columns, and thread members come with the bot name.
// See packages/gateway/docs/http-api.md.

import type {
  ActivitySummary,
  Approval,
  BotDefinition,
  BrowserLock,
  CostAlert,
  EffectiveLimit,
  DeskmatesErrorCode,
  GroupRouting,
  Run,
  RunEvent,
  Thread,
  ThreadId,
  ThreadMember,
  ThreadMembersEvent,
  ThreadMessage,
  ThreadPinsEvent,
  WelcomeDelivery,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";

/** `Run` plus the columns the Gateway adds to every run response. */
export interface RunView extends Run {
  createdAt: string;
  /** Knob configuration recorded in `runs.config_json`. */
  config: Record<string, unknown>;
  deliveredSeq?: number;
  error?: string;
  /** ADR-0033: the summary this run shows now, when the run list carries one. */
  activitySummary?: ActivitySummary;
  /** ADR-0005 amendment 4: the rounds (originating message ids) this run answers. */
  roundMessageIds?: string[];
  /** ADR-0024 amendment 2, decision 11: for a welcome run, whether its greeting reached the chat. */
  welcomeDelivery?: WelcomeDelivery;
}

/** A bot's versioned Markdown file (SOUL.md or MEMORY.md) as the Gateway returns it. */
export interface MemoryView {
  body: string;
  version: string;
}

export type NamedThreadMember = ThreadMember & { name: string };

/**
 * What the thread detail and membership routes return. `groupRouting` is how this Gateway routes
 * a message with no mention (ADR-0005 amendment 2); an older Gateway omits it and walks.
 */
export interface ThreadDetailView {
  thread: Thread;
  members: NamedThreadMember[];
  groupRouting?: GroupRouting;
  /**
   * The turn budget the router enforces (ADR-0005 amendment 5 decision 38): the workspace
   * setting, else `thread.turnBudget`; `value: null` when the workspace turned it off. An older
   * Gateway omits it.
   */
  effectiveTurnBudget?: EffectiveLimit;
}

/**
 * What `GET /api/workspaces/:id` returns: the workspace, its bots, the human hold on the shared
 * browser (never a run's tab lock) and whether its container publishes the shared screen, false
 * until it exists (ADR-0004, design v0.3 §3.3). The screen is reached only through the Gateway's
 * screen proxy, never by address (ADR-0022 amendment 1, C7).
 */
export interface WorkspaceView {
  workspace: Workspace;
  capacity?: { activeAttempts: number; waitingRunIds: string[] };
  bots: BotDefinition[];
  browserLock: BrowserLock | null;
  takeoverScreen: boolean;
}

/** One SSE frame from `GET /api/events`; `data` is this object, `event` is `type`. */
export type GatewayEvent =
  | import("@deskmates/contracts").ThreadActivityEvent
  | { type: "run_status"; threadId?: ThreadId; run: RunView }
  | { type: "run_event"; threadId?: ThreadId; event: RunEvent }
  /** A live run's cumulative reply preview; the final message replaces it (ADR-0037). */
  | {
      type: "run_reply_preview";
      threadId: ThreadId;
      preview: import("@deskmates/contracts").ReplyPreviewFrame;
    }
  | { type: "thread_message"; threadId: ThreadId; message: ThreadMessage }
  | ThreadMembersEvent
  | ThreadPinsEvent
  /** Emitted when a run asks for approval and again when the approval is decided (ADR-0002 amendment 2). */
  | { type: "approval"; threadId?: ThreadId; approval: Approval }
  /**
   * Emitted when a human takes the workspace browser over and again when they hand it back.
   * It carries no `threadId`, so only an unfiltered `/api/events` stream delivers it.
   */
  | { type: "workspace_lock"; workspaceId: WorkspaceId; browserLock: BrowserLock | null }
  /** The workspace row changed (an allowlist edit or an egress ask allowed, ADR-0020). Unfiltered streams only. */
  | { type: "workspace"; workspaceId: WorkspaceId; workspace: Workspace }
  /** A cost alert rule fired (ADR-0018 decision 4). No `threadId`: unfiltered streams only. */
  | { type: "cost_alert"; alert: CostAlert }
  /** A workspace's message board changed (ADR-0022 amendment 6 W10). Unfiltered streams only. */
  | { type: "board"; workspaceId: WorkspaceId };

export type GatewayEventType = GatewayEvent["type"];

export const GATEWAY_EVENT_TYPES: readonly GatewayEventType[] = [
  "run_status",
  "run_event",
  "run_reply_preview",
  "thread_message",
  "thread_members",
  "thread_pins",
  "thread_activity",
  "approval",
  "workspace_lock",
  "cost_alert",
  "workspace",
  "board",
];

/** Error body: `{code, message, details}` with an HTTP status attached client-side. */
export class ApiError extends Error {
  readonly code: DeskmatesErrorCode | "network" | "unknown";
  readonly status: number;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ApiError["code"],
    message: string,
    status: number,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}
