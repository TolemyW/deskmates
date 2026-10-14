// ADR-0007 candidate origin queue. Origins coordinate shared browser work; they are never bot
// permissions. The store is durable so retries retain FIFO position and dead processes age out.

import type {
  BrowserOriginRequest,
  BrowserOriginResponse,
  RunId,
  WorkspaceId,
} from "@deskmates/contracts";
import { DeskmatesError } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

export const BROWSER_ORIGIN_TTL_SECONDS_DEFAULT = 120;
export const BROWSER_ORIGIN_RETRY_AFTER_MS = 250;

export type BrowserOriginQueueStatus = "pending" | "held";

interface OriginQueueRow {
  id: number;
  workspace_id: string;
  run_id: string;
  origin: string;
  status: BrowserOriginQueueStatus;
  queued_at: string;
  granted_at: string | null;
  expires_at: string;
}

export interface BrowserOriginQueueEntry {
  id: number;
  workspaceId: WorkspaceId;
  runId: RunId;
  origin: string;
  status: BrowserOriginQueueStatus;
  queuedAt: string;
  grantedAt?: string;
  expiresAt: string;
}

export class BrowserOriginQueueStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly ttlSeconds: number = BROWSER_ORIGIN_TTL_SECONDS_DEFAULT,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  handle(
    workspaceId: WorkspaceId,
    req: BrowserOriginRequest,
    humanHolds: boolean,
  ): BrowserOriginResponse {
    return this.db.transaction(() => {
      const now = this.clock();
      this.expire(workspaceId, now);
      if (req.op === "release") {
        const origin = req.origin === undefined ? undefined : this.canonicalOrigin(req.origin);
        this.release(req.runId, origin);
        return this.response(req, true, origin);
      }
      if (req.op === "renew") return this.renew(workspaceId, req, humanHolds, now);
      return this.acquire(workspaceId, req, humanHolds, now);
    })();
  }

  /** Lifecycle cleanup for completion, failure, cancellation and approval parking. */
  releaseForRun(runId: RunId): void {
    this.db.prepare("DELETE FROM browser_origin_queue WHERE run_id = ?").run(runId);
  }

  /** Human takeover revokes every grant but retains each request's original FIFO position. */
  preempt(workspaceId: WorkspaceId): void {
    const expiresAt = this.expiresAt(this.clock());
    this.db
      .prepare(
        `UPDATE browser_origin_queue
         SET status = 'pending', granted_at = NULL, expires_at = ?
         WHERE workspace_id = ? AND status = 'held'`,
      )
      .run(expiresAt, workspaceId);
  }

  /** Audit/test view; expired entries are not observable as live coordination state. */
  list(workspaceId: WorkspaceId): BrowserOriginQueueEntry[] {
    this.expire(workspaceId, this.clock());
    return (
      this.db
        .prepare(
          `SELECT id, workspace_id, run_id, origin, status, queued_at, granted_at, expires_at
           FROM browser_origin_queue WHERE workspace_id = ? ORDER BY id`,
        )
        .all(workspaceId) as OriginQueueRow[]
    ).map((row) => ({
      id: row.id,
      workspaceId: row.workspace_id as WorkspaceId,
      runId: row.run_id as RunId,
      origin: row.origin,
      status: row.status,
      queuedAt: row.queued_at,
      ...(row.granted_at === null ? {} : { grantedAt: row.granted_at }),
      expiresAt: row.expires_at,
    }));
  }

  private acquire(
    workspaceId: WorkspaceId,
    req: BrowserOriginRequest,
    humanHolds: boolean,
    now: Date,
  ): BrowserOriginResponse {
    const origin = this.requiredOrigin(req);
    let row = this.forRun(req.runId);
    if (row !== undefined && (row.workspace_id !== workspaceId || row.origin !== origin)) {
      // Release-before-switch: a run can never hold or queue for two origins at once.
      this.releaseForRun(req.runId);
      row = undefined;
    }
    if (row === undefined) {
      const queuedAt = now.toISOString();
      const result = this.db
        .prepare(
          `INSERT INTO browser_origin_queue
             (workspace_id, run_id, origin, status, queued_at, expires_at)
           VALUES (?, ?, ?, 'pending', ?, ?)`,
        )
        .run(workspaceId, req.runId, origin, queuedAt, this.expiresAt(now));
      row = this.byId(Number(result.lastInsertRowid));
    } else {
      this.refresh(row.id, now);
      row = { ...row, expires_at: this.expiresAt(now) };
    }

    if (humanHolds) {
      if (row.status === "held") this.setPending(row.id, now);
      return this.response(req, false, origin, "human");
    }
    if (row.status === "held") return this.response(req, true, origin);

    const holder = this.holder(workspaceId, origin);
    const head = this.head(workspaceId, origin);
    if (holder === undefined && head?.id === row.id) {
      this.db
        .prepare(
          `UPDATE browser_origin_queue
           SET status = 'held', granted_at = ?, expires_at = ? WHERE id = ?`,
        )
        .run(now.toISOString(), this.expiresAt(now), row.id);
      return this.response(req, true, origin);
    }
    return this.response(req, false, origin, "origin_busy");
  }

  private renew(
    workspaceId: WorkspaceId,
    req: BrowserOriginRequest,
    humanHolds: boolean,
    now: Date,
  ): BrowserOriginResponse {
    const origin = this.requiredOrigin(req);
    const row = this.forRun(req.runId);
    if (
      row === undefined ||
      row.workspace_id !== workspaceId ||
      row.origin !== origin ||
      row.status !== "held"
    ) {
      return this.response(req, false, origin, "lease_lost");
    }
    if (humanHolds) {
      this.setPending(row.id, now);
      return this.response(req, false, origin, "human");
    }
    this.refresh(row.id, now);
    return this.response(req, true, origin);
  }

  private response(
    req: BrowserOriginRequest,
    granted: boolean,
    origin = req.origin,
    waitReason?: BrowserOriginResponse["waitReason"],
  ): BrowserOriginResponse {
    return {
      type: "browser_origin_result",
      runId: req.runId,
      granted,
      ...(origin === undefined ? {} : { origin }),
      ...(waitReason === undefined
        ? {}
        : { waitReason, retryAfterMs: BROWSER_ORIGIN_RETRY_AFTER_MS }),
    };
  }

  private requiredOrigin(req: BrowserOriginRequest): string {
    if (req.origin === undefined || req.origin === "") {
      throw new DeskmatesError("validation", `${req.op} requires an origin`);
    }
    return this.canonicalOrigin(req.origin);
  }

  private canonicalOrigin(origin: string): string {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new DeskmatesError("validation", "origin must be a canonical HTTP(S) origin", {
        origin,
      });
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      origin !== parsed.origin
    ) {
      throw new DeskmatesError("validation", "origin must be a canonical HTTP(S) origin", {
        origin,
      });
    }
    return parsed.origin;
  }

  private release(runId: RunId, origin: string | undefined): void {
    if (origin === undefined) {
      this.releaseForRun(runId);
      return;
    }
    this.db
      .prepare("DELETE FROM browser_origin_queue WHERE run_id = ? AND origin = ?")
      .run(runId, origin);
  }

  private forRun(runId: RunId): OriginQueueRow | undefined {
    return this.db.prepare("SELECT * FROM browser_origin_queue WHERE run_id = ?").get(runId) as
      | OriginQueueRow
      | undefined;
  }

  private byId(id: number): OriginQueueRow {
    return this.db
      .prepare("SELECT * FROM browser_origin_queue WHERE id = ?")
      .get(id) as OriginQueueRow;
  }

  private holder(workspaceId: WorkspaceId, origin: string): OriginQueueRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM browser_origin_queue
         WHERE workspace_id = ? AND origin = ? AND status = 'held'`,
      )
      .get(workspaceId, origin) as OriginQueueRow | undefined;
  }

  private head(workspaceId: WorkspaceId, origin: string): OriginQueueRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM browser_origin_queue
         WHERE workspace_id = ? AND origin = ? ORDER BY id LIMIT 1`,
      )
      .get(workspaceId, origin) as OriginQueueRow | undefined;
  }

  private setPending(id: number, now: Date): void {
    this.db
      .prepare(
        `UPDATE browser_origin_queue
         SET status = 'pending', granted_at = NULL, expires_at = ? WHERE id = ?`,
      )
      .run(this.expiresAt(now), id);
  }

  private refresh(id: number, now: Date): void {
    this.db
      .prepare("UPDATE browser_origin_queue SET expires_at = ? WHERE id = ?")
      .run(this.expiresAt(now), id);
  }

  private expire(workspaceId: WorkspaceId, now: Date): void {
    this.db
      .prepare("DELETE FROM browser_origin_queue WHERE workspace_id = ? AND expires_at <= ?")
      .run(workspaceId, now.toISOString());
  }

  private expiresAt(now: Date): string {
    return new Date(now.getTime() + this.ttlSeconds * 1000).toISOString();
  }
}
