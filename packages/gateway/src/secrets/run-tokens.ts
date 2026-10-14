// Short-lived per-sidecar-process model tokens (ADR-0002 item 4 and definitions).
// The token is random and opaque; only its SHA-256 is stored, keyed by run. The upstream
// MODEL_AUTH_TOKEN never enters this table or any other.

import { createHash, randomBytes } from "node:crypto";
import type { RunId } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

/**
 * How long a revoked token stays in the table. It cannot authenticate anything the moment it is
 * revoked; the window only keeps it readable while an operator is still looking at the run that
 * just ended.
 */
export const REVOKED_TOKEN_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface IssuedToken {
  token: string;
  runId: RunId;
  expiresAt: string;
}

export interface TokenVerification {
  runId: RunId;
  expiresAt: string;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export class RunTokenStore {
  constructor(
    private readonly db: GatewayDb,
    private readonly ttlSeconds: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  issue(runId: RunId): IssuedToken {
    const token = `cbt_${randomBytes(32).toString("base64url")}`;
    const now = this.clock();
    const expiresAt = new Date(now.getTime() + this.ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        "INSERT INTO run_tokens (token_hash, run_id, issued_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(hashToken(token), runId, now.toISOString(), expiresAt);
    return { token, runId, expiresAt };
  }

  /** The run this token authenticates, or undefined when unknown, expired or revoked. */
  verify(token: string): TokenVerification | undefined {
    const row = this.db
      .prepare("SELECT run_id, expires_at, revoked_at FROM run_tokens WHERE token_hash = ?")
      .get(hashToken(token)) as
      | { run_id: string; expires_at: string; revoked_at: string | null }
      | undefined;
    if (!row || row.revoked_at !== null) return undefined;
    if (row.expires_at <= this.clock().toISOString()) return undefined;
    return { runId: row.run_id as RunId, expiresAt: row.expires_at };
  }

  /** Revokes every live token of the run; called when it reaches a terminal or parked state. */
  revokeForRun(runId: RunId): number {
    const result = this.db
      .prepare("UPDATE run_tokens SET revoked_at = ? WHERE run_id = ? AND revoked_at IS NULL")
      .run(this.clock().toISOString(), runId);
    return result.changes;
  }

  /**
   * Deletes tokens that can no longer authenticate anything: past their expiry, or revoked more
   * than `REVOKED_TOKEN_RETENTION_MS` ago. One row is written per sidecar process and nothing
   * ever removed them, so the table grew with every run for the life of the deployment. Called
   * by the scheduler; returns how many rows went.
   */
  pruneExpired(now: Date = this.clock()): number {
    const revokedBefore = new Date(now.getTime() - REVOKED_TOKEN_RETENTION_MS).toISOString();
    const result = this.db
      .prepare(
        "DELETE FROM run_tokens WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)",
      )
      .run(now.toISOString(), revokedBefore);
    return result.changes;
  }
}
