// In-process fan-out of ledger changes to SSE clients. Not persistence: the ledger is the truth,
// this only tells connected clients that it changed.

import type {
  Approval,
  BrowserLock,
  CostAlert,
  RunEvent,
  RunId,
  Task,
  ThreadActivityEvent,
  ThreadId,
  ThreadMembersEvent,
  ThreadMessage,
  ThreadPinsEvent,
  Workspace,
  WorkspaceId,
} from "@deskmates/contracts";
import type { RunRecord } from "../ledger/runs.js";

export type GatewayEvent =
  | { type: "run_status"; threadId?: ThreadId; run: RunRecord }
  | { type: "run_event"; threadId?: ThreadId; event: RunEvent }
  | { type: "thread_message"; threadId: ThreadId; message: ThreadMessage }
  | ThreadMembersEvent
  | ThreadActivityEvent
  | ThreadPinsEvent
  /** An approval was posted or settled; the UI redraws its card and its inbox (ADR-0002 A1). */
  | { type: "approval"; threadId?: ThreadId; approval: Approval }
  /**
   * The workspace browser changed hands: a human took over (`browserLock` is the human lock) or
   * handed it back (`null`). Workspace-wide, so it carries no thread (ADR-0004 decision 6).
   */
  | {
      type: "workspace_lock";
      threadId?: ThreadId;
      workspaceId: WorkspaceId;
      browserLock: BrowserLock | null;
    }
  /**
   * The workspace row changed — in M1 that means an operator replaced its egress allowlist — so
   * the UI redraws it. Workspace-wide, so it carries no thread.
   */
  | { type: "workspace"; threadId?: ThreadId; workspaceId: WorkspaceId; workspace: Workspace }
  /**
   * A cost alert rule fired for the window a run's usage landed in (ADR-0018 decision 4). An
   * operator fact with no thread, so only an unfiltered stream delivers it.
   */
  | { type: "cost_alert"; threadId?: ThreadId; alert: CostAlert }
  /**
   * A bot delivered a task with `task_deliver` (ADR-0021 amendment 2). Carries the delivering run's
   * thread when it has one, so a thread view hears it; the task list refreshes on its own terms.
   */
  | {
      type: "task_delivered";
      threadId?: ThreadId;
      workspaceId: WorkspaceId;
      task: Task;
      runId: RunId;
      summary: string;
    }
  /** The workspace's message board changed (ADR-0022 amendment 6 W10); clients refetch it. */
  | { type: "board"; workspaceId: WorkspaceId };

export type GatewayEventListener = (event: GatewayEvent) => void;

export class EventBus {
  private readonly listeners = new Set<GatewayEventListener>();
  private pending: GatewayEvent[] | undefined;

  /**
   * Buffer a synchronous operation that commits its database transaction before returning.
   * Nested failures discard only their own events; an outer rollback discards everything.
   * Publish transcript rows before the runs they wake, in sequence order within each thread.
   */
  batch<T>(operation: () => T): T {
    const parent = this.pending;
    const pending: GatewayEvent[] = [];
    this.pending = pending;
    let result: T;
    try {
      result = operation();
    } catch (error) {
      this.pending = parent;
      throw error;
    }
    this.pending = parent;
    if (parent) {
      parent.push(...pending);
    } else {
      const messages = new Map<ThreadId, Extract<GatewayEvent, { type: "thread_message" }>[]>();
      for (const event of pending) {
        if (event.type !== "thread_message") continue;
        const rows = messages.get(event.threadId) ?? [];
        rows.push(event);
        messages.set(event.threadId, rows);
      }
      for (const rows of messages.values()) {
        for (const event of rows.sort((a, b) => a.message.seq - b.message.seq)) this.publish(event);
      }
      for (const event of pending) {
        if (event.type !== "thread_message") this.publish(event);
      }
    }
    return result;
  }

  subscribe(listener: GatewayEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  publish(event: GatewayEvent): void {
    if (this.pending) {
      this.pending.push(event);
      return;
    }
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // A broken subscriber must not break the publisher.
      }
    }
  }

  get size(): number {
    return this.listeners.size;
  }
}
