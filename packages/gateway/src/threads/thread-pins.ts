import { DeskmatesError, type ThreadId, type WorkspaceId } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { ThreadStore } from "./threads.js";

export interface ThreadPin {
  workspaceId: WorkspaceId;
  threadId: ThreadId;
  position: number;
  pinnedBy: string;
  pinnedAt: string;
}

interface ThreadPinRow {
  workspace_id: WorkspaceId;
  thread_id: ThreadId;
  position: number;
  pinned_by: string;
  pinned_at: string;
}

/** Workspace-shared rail presentation. No routing or scheduler path reads this store. */
export class ThreadPinStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly threads: ThreadStore,
  ) {}

  get(threadId: ThreadId): ThreadPin | undefined {
    const row = this.db.prepare("SELECT * FROM thread_pins WHERE thread_id = ?").get(threadId) as
      | ThreadPinRow
      | undefined;
    return row ? toPin(row) : undefined;
  }

  list(workspaceId: WorkspaceId): ThreadPin[] {
    return (
      this.db
        .prepare("SELECT * FROM thread_pins WHERE workspace_id = ? ORDER BY position")
        .all(workspaceId) as ThreadPinRow[]
    ).map(toPin);
  }

  pin(threadId: ThreadId, actor: string): ThreadPin {
    return this.db.transaction(() => {
      const thread = this.threads.mustGet(threadId);
      if (thread.kind !== "chat") {
        throw new DeskmatesError("validation", "only human chat threads can be pinned", {
          threadId,
        });
      }
      const existing = this.get(threadId);
      if (existing) return existing;
      const next = (
        this.db
          .prepare(
            "SELECT coalesce(max(position), 0) + 1 AS position FROM thread_pins WHERE workspace_id = ?",
          )
          .get(thread.workspaceId) as { position: number }
      ).position;
      this.db
        .prepare(
          "INSERT INTO thread_pins(workspace_id, thread_id, position, pinned_by, pinned_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(thread.workspaceId, threadId, next, actor, nowIso());
      return this.get(threadId) as ThreadPin;
    })();
  }

  unpin(threadId: ThreadId): boolean {
    this.threads.mustGet(threadId);
    return this.db.prepare("DELETE FROM thread_pins WHERE thread_id = ?").run(threadId).changes > 0;
  }
}

function toPin(row: ThreadPinRow): ThreadPin {
  return {
    workspaceId: row.workspace_id,
    threadId: row.thread_id,
    position: row.position,
    pinnedBy: row.pinned_by,
    pinnedAt: row.pinned_at,
  };
}
