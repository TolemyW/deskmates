// Workspace browser lock, version 1 (ADR-0004; design v0.3 §3.3). Held by the Gateway, acquired
// from the sidecar's PreToolUse hook. A human holder is exclusive for the workspace; a run holder
// guards one tab with a TTL renewed on each browser tool call and released when the run ends.
// Calls without a stable tab id keep the M0 compatibility behavior and do not contend with other
// run holders. They still record a lease so expiry and run cleanup work as before.

import {
  type BrowserLock,
  type BrowserLockRequest,
  type BrowserLockResponse,
  HUMAN_HOLDS_BROWSER_MESSAGE,
  type RunId,
  type WorkspaceId,
} from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

export const BROWSER_LOCK_TTL_SECONDS_DEFAULT = 120;
export const TAB_HELD_BY_RUN_MESSAGE =
  "Another run is operating this browser tab. Wait and retry after it releases the tab.";

interface LockRow {
  workspace_id: string;
  holder_kind: "run" | "human";
  holder_run_id: string | null;
  tab_id: string | null;
  acquired_at: string;
  expires_at: string;
}

export class BrowserLockStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly ttlSeconds: number = BROWSER_LOCK_TTL_SECONDS_DEFAULT,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** Handles a sidecar lock request for the run's workspace. */
  handle(workspaceId: WorkspaceId, req: BrowserLockRequest): BrowserLockResponse {
    const now = this.clock();
    this.expire(workspaceId, now);
    if (req.op === "release") {
      this.releaseForRun(req.runId, req.tabId);
      return { type: "browser_lock_result", runId: req.runId, granted: true };
    }
    if (this.hasHumanLock(workspaceId)) {
      return {
        type: "browser_lock_result",
        runId: req.runId,
        granted: false,
        waitMessage: HUMAN_HOLDS_BROWSER_MESSAGE,
      };
    }

    return this.db.transaction((): BrowserLockResponse => {
      const owned = this.runLock(workspaceId, req.runId);
      // A renewal proves continuity of an existing lease. Once its TTL has expired the caller
      // must acquire again, so a stale browser call cannot silently resume after losing ownership.
      if (
        req.op === "renew" &&
        (owned === undefined ||
          (req.tabId !== undefined && owned.tab_id !== null && owned.tab_id !== req.tabId))
      ) {
        return this.waitForTab(req.runId);
      }

      if (req.tabId !== undefined && this.tabHeldByOtherRun(workspaceId, req.runId, req.tabId)) {
        return this.waitForTab(req.runId);
      }

      const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000).toISOString();
      if (owned === undefined) {
        this.db
          .prepare(
            `INSERT INTO browser_locks
               (workspace_id, holder_kind, holder_run_id, tab_id, acquired_at, expires_at)
             VALUES (?, 'run', ?, ?, ?, ?)`,
          )
          .run(workspaceId, req.runId, req.tabId ?? null, now.toISOString(), expiresAt);
      } else {
        const nextTabId = req.tabId ?? owned.tab_id;
        const moved = nextTabId !== owned.tab_id;
        this.db
          .prepare(
            `UPDATE browser_locks
             SET tab_id = ?, acquired_at = ?, expires_at = ?
             WHERE workspace_id = ? AND holder_kind = 'run' AND holder_run_id = ?`,
          )
          .run(
            nextTabId,
            moved ? now.toISOString() : owned.acquired_at,
            expiresAt,
            workspaceId,
            req.runId,
          );
      }
      return { type: "browser_lock_result", runId: req.runId, granted: true };
    })();
  }

  humanHolds(workspaceId: WorkspaceId): boolean {
    this.expire(workspaceId, this.clock());
    return this.hasHumanLock(workspaceId);
  }

  epoch(workspaceId: WorkspaceId): number {
    return (
      (
        this.db.prepare("SELECT browser_epoch FROM workspaces WHERE id = ?").get(workspaceId) as
          | { browser_epoch: number }
          | undefined
      )?.browser_epoch ?? 0
    );
  }

  /** A human takes over the screen; exclusive for the whole workspace. */
  humanTake(
    workspaceId: WorkspaceId,
    ttlSeconds = 3600,
    holder: string | null = null,
  ): BrowserLock {
    return this.db.transaction(() => {
      this.db
        .prepare("UPDATE workspaces SET browser_epoch = browser_epoch + 1 WHERE id = ?")
        .run(workspaceId);
      const now = this.clock();
      const expiresAt = new Date(now.getTime() + ttlSeconds * 1000).toISOString();
      this.db
        .prepare(
          `INSERT INTO browser_locks (workspace_id, holder_kind, holder_run_id, acquired_at, expires_at,
             holder_principal)
         VALUES (?, 'human', NULL, ?, ?, ?)
         ON CONFLICT (workspace_id) WHERE holder_kind = 'human' DO UPDATE SET
           expires_at = excluded.expires_at, holder_principal = excluded.holder_principal`,
        )
        .run(workspaceId, now.toISOString(), expiresAt, holder);
      return {
        workspaceId,
        holderKind: "human" as const,
        acquiredAt: now.toISOString(),
        expiresAt,
      };
    })();
  }

  /**
   * Who holds the workspace's human lease: undefined when nobody does, null for a lease with no
   * recorded holder (taken before holders were recorded).
   */
  humanHolder(workspaceId: WorkspaceId): string | null | undefined {
    this.expire(workspaceId, this.clock());
    const row = this.db
      .prepare(
        "SELECT holder_principal FROM browser_locks WHERE workspace_id = ? AND holder_kind = 'human'",
      )
      .get(workspaceId) as { holder_principal: string | null } | undefined;
    return row === undefined ? undefined : row.holder_principal;
  }

  /** Every human lease with a recorded holder, for the revocation sweep. */
  humanLeases(): Array<{ workspaceId: WorkspaceId; holder: string }> {
    return (
      this.db
        .prepare(
          `SELECT workspace_id, holder_principal FROM browser_locks
           WHERE holder_kind = 'human' AND holder_principal IS NOT NULL`,
        )
        .all() as Array<{ workspace_id: string; holder_principal: string }>
    ).map((row) => ({
      workspaceId: row.workspace_id as WorkspaceId,
      holder: row.holder_principal,
    }));
  }

  humanRelease(workspaceId: WorkspaceId): void {
    this.db
      .prepare("DELETE FROM browser_locks WHERE workspace_id = ? AND holder_kind = 'human'")
      .run(workspaceId);
  }

  releaseForRun(runId: RunId, tabId?: string): void {
    if (tabId === undefined) {
      this.db.prepare("DELETE FROM browser_locks WHERE holder_run_id = ?").run(runId);
      return;
    }
    this.db
      .prepare("DELETE FROM browser_locks WHERE holder_run_id = ? AND tab_id = ?")
      .run(runId, tabId);
  }

  list(workspaceId: WorkspaceId): BrowserLock[] {
    this.expire(workspaceId, this.clock());
    const rows = this.db
      .prepare("SELECT * FROM browser_locks WHERE workspace_id = ? ORDER BY id")
      .all(workspaceId) as LockRow[];
    return rows.map((r) => {
      const lock: BrowserLock = {
        workspaceId: r.workspace_id as WorkspaceId,
        holderKind: r.holder_kind,
        acquiredAt: r.acquired_at,
        expiresAt: r.expires_at,
      };
      if (r.holder_run_id !== null) lock.holderRunId = r.holder_run_id as RunId;
      if (r.tab_id !== null) lock.tabId = r.tab_id;
      return lock;
    });
  }

  private runLock(workspaceId: WorkspaceId, runId: RunId): LockRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM browser_locks WHERE workspace_id = ? AND holder_kind = 'run' AND holder_run_id = ?",
      )
      .get(workspaceId, runId) as LockRow | undefined;
  }

  private tabHeldByOtherRun(workspaceId: WorkspaceId, runId: RunId, tabId: string): boolean {
    return (
      this.db
        .prepare(
          `SELECT 1 FROM browser_locks
           WHERE workspace_id = ? AND holder_kind = 'run' AND holder_run_id <> ? AND tab_id = ?`,
        )
        .get(workspaceId, runId, tabId) !== undefined
    );
  }

  private hasHumanLock(workspaceId: WorkspaceId): boolean {
    return (
      this.db
        .prepare("SELECT 1 FROM browser_locks WHERE workspace_id = ? AND holder_kind = 'human'")
        .get(workspaceId) !== undefined
    );
  }

  private waitForTab(runId: RunId): BrowserLockResponse {
    return {
      type: "browser_lock_result",
      runId,
      granted: false,
      waitMessage: TAB_HELD_BY_RUN_MESSAGE,
    };
  }

  private expire(workspaceId: WorkspaceId, now: Date): void {
    this.db
      .prepare("DELETE FROM browser_locks WHERE workspace_id = ? AND expires_at <= ?")
      .run(workspaceId, now.toISOString());
  }
}
