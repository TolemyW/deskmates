// Per-tenant limits (ADR-0022 decision 4, test plan LIMIT-01): one tenant's traffic or queue
// cannot exhaust what another tenant needs. Concurrent sidecars are not capped (ADR-0022
// amendment 5): each workspace container's CPU and memory limits bound them. This module caps
// queued runs, the operator API request rate, and open event streams and desktop connections,
// which the request rate does not bound because they stay open. All are soft operational limits,
// not security boundaries, and all are per process. A service principal's daily cost budget is
// checked here too; it reads the database, so it holds across processes.

import { DeskmatesError } from "@deskmates/contracts";
import type { GatewayDb } from "../db/open.js";

/** Queued runs one tenant may have waiting across its workspaces. */
export const TENANT_MAX_QUEUED_RUNS_DEFAULT = 200;
/** Operator API requests one tenant may make per minute (all its people together). */
export const TENANT_API_REQUESTS_PER_MINUTE_DEFAULT = 1200;
/** Open `/api/events` streams one tenant may hold (all its people and tabs together). */
export const TENANT_MAX_EVENT_STREAMS_DEFAULT = 200;
/** Desktop tickets plus open desktop streams one tenant may hold. */
export const TENANT_MAX_DESKTOP_CONNECTIONS_DEFAULT = 32;

export interface TenantQuotaLimits {
  maxQueuedRuns: number;
  apiRequestsPerMinute: number;
  maxEventStreams: number;
  maxDesktopConnections: number;
}

interface Bucket {
  tokens: number;
  updatedMs: number;
}

export class TenantQuotas {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly db: GatewayDb,
    readonly limits: TenantQuotaLimits,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  queuedRuns(tenantId: string): number {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM runs r JOIN bots b ON b.id = r.bot_id
           JOIN workspaces w ON w.id = b.workspace_id
           WHERE w.tenant_id = ? AND r.status = 'queued'`,
        )
        .get(tenantId) as { n: number }
    ).n;
  }

  /** Refuse new work while the tenant's queue is full; 0 disables the cap. */
  assertQueueRoom(tenantId: string): void {
    const max = this.limits.maxQueuedRuns;
    if (max <= 0) return;
    const queued = this.queuedRuns(tenantId);
    if (queued >= max)
      throw new DeskmatesError("queue_full", "this tenant has too many runs waiting", {
        queued,
        max,
      });
  }

  /**
   * A service principal's own budget (ADR-0022 amendment 2), checked before one of its messages
   * is posted: the known (Gateway-priced) cost of its runs created today (UTC, the cost report's
   * day). "Its runs" are runs whose triggering message it authored; relays a bot starts
   * afterwards are the bot's. Unpriced usage is unknown and does not count. How many of its runs
   * are in flight is not limited (amendment 5).
   */
  assertServicePrincipalBudget(principal: { servicePrincipalId: string; tenantId: string }): void {
    const limits = this.db
      .prepare("SELECT daily_usd_cap FROM service_principals WHERE id = ? AND tenant_id = ?")
      .get(principal.servicePrincipalId, principal.tenantId) as
      | { daily_usd_cap: number }
      | undefined;
    if (!limits)
      throw new DeskmatesError("token_rejected", "missing or invalid operator credential");
    const author = `service:${principal.servicePrincipalId}`;
    const day = this.clock().toISOString().slice(0, 10);
    const spent =
      (
        this.db
          .prepare(
            `SELECT SUM(u.cost_usd) AS usd FROM thread_messages m
               JOIN runs r ON r.trigger_ref = m.id AND r.trigger_kind = 'thread_message'
               JOIN run_usage u ON u.run_id = r.id
              WHERE m.author_id = ? AND substr(r.created_at, 1, 10) = ?`,
          )
          .get(author, day) as { usd: number | null }
      ).usd ?? 0;
    // Six decimal places, the precision usage rows are priced at.
    const spentUsd = Math.round(spent * 1_000_000) / 1_000_000;
    if (spentUsd >= limits.daily_usd_cap)
      throw new DeskmatesError("budget_exceeded", "this service principal spent today's budget", {
        limit: "daily_usd",
        spentUsd,
        capUsd: limits.daily_usd_cap,
        day,
      });
  }

  /**
   * Refuse one more long-lived connection of a kind while the tenant already holds `open` of
   * them; 0 disables the cap.
   */
  assertConnectionRoom(kind: "event_stream" | "desktop", open: number): void {
    const max =
      kind === "event_stream" ? this.limits.maxEventStreams : this.limits.maxDesktopConnections;
    if (max <= 0 || open < max) return;
    throw new DeskmatesError(
      "queue_full",
      kind === "event_stream"
        ? "this tenant has too many event streams open"
        : "this tenant has too many desktop connections open",
      { open, max },
    );
  }

  /**
   * Take one request from the tenant's token bucket (refilled continuously, burst = one minute
   * of requests). Throws `rate_limited` with a retry hint when it is empty; 0 disables the limit.
   */
  takeRequest(tenantId: string): void {
    const perMinute = this.limits.apiRequestsPerMinute;
    if (perMinute <= 0) return;
    const now = this.clock().getTime();
    const bucket = this.buckets.get(tenantId) ?? { tokens: perMinute, updatedMs: now };
    bucket.tokens = Math.min(
      perMinute,
      bucket.tokens + ((now - bucket.updatedMs) * perMinute) / 60_000,
    );
    bucket.updatedMs = now;
    if (bucket.tokens < 1) {
      this.buckets.set(tenantId, bucket);
      const retryAfterSeconds = Math.ceil(((1 - bucket.tokens) * 60) / perMinute);
      throw new DeskmatesError("rate_limited", "this tenant is sending too many requests", {
        retryAfterSeconds,
      });
    }
    bucket.tokens -= 1;
    this.buckets.set(tenantId, bucket);
  }
}
