// "Needs revalidation" (ADR-0011 amendment 4, A25 to A28): a bounded, idempotent sweep keeps one
// open flag per current note that a human should look at again, and a human answers it. The
// sweep writes only flag rows: it never changes a note, never creates a run, and nothing here
// changes what a run receives.

import {
  DEFAULT_MEMORY_FRESHNESS_POLICY,
  DeskmatesError,
  type MemoryEntry,
  type MemoryFreshnessPolicy,
  type MemoryFreshnessReason,
  type MemoryRecheckVerdict,
  type MemoryRevalidation,
  type MemoryRevalidationDecision,
  type MemoryRevalidationOutcome,
  type WorkspaceId,
  memoryFreshness,
} from "@deskmates/contracts";
import type { AuditLog } from "../audit/audit-log.js";
import { newId } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { MemoryEntryStore } from "./entries.js";

const SYSTEM = "system:memory-freshness";
/** The periodic pass sweeps one workspace at most this often (A26). */
export const FRESHNESS_SWEEP_INTERVAL_MS = 3_600_000;
/** Workspaces one periodic pass sweeps, so a large deployment never stalls the scheduler. */
const SWEEPS_PER_PASS = 20;

interface CandidateRow {
  id: string;
  scope: "workspace" | "bot";
  trust: MemoryEntry["trust"];
  version: number;
  observed_at: string;
  effective_at: string | null;
  last_confirmed_at: string | null;
  ttl_seconds: number | null;
  replaced_trusted: number;
}

interface FlagRow {
  id: string;
  workspace_id: string;
  entry_id: string;
  entry_version: number;
  reason: MemoryFreshnessReason;
  status: MemoryRevalidationOutcome;
  horizon_days: number;
  flagged_at: string;
  decided_by: string | null;
  decided_at: string | null;
  model_verdict: MemoryRecheckVerdict | null;
  model_reason: string | null;
  model_checked_at: string | null;
  model_run_id: string | null;
  model_entry_version: number | null;
}

/** A26: a flag a person must answer: `replaced_trusted`, or a model `possibly_stale` (A28). */
const NEEDS_HUMAN_SQL = "(reason = 'replaced_trusted' OR model_verdict = 'possibly_stale')";

export interface SweepResult {
  flagged: number;
  updated: number;
  closed: number;
}

function horizon(scope: "workspace" | "bot", policy: MemoryFreshnessPolicy): number {
  return scope === "bot" ? policy.botDays : policy.workspaceDays;
}

export class MemoryFreshness {
  constructor(
    private readonly db: GatewayDb,
    private readonly entries: MemoryEntryStore,
    private readonly policy: MemoryFreshnessPolicy = DEFAULT_MEMORY_FRESHNESS_POLICY,
  ) {}

  /**
   * A26: flag qualifying notes, refresh open flags, close the ones that no longer qualify. One
   * transaction; running it twice, or after a restart, gives the same rows.
   */
  sweep(workspaceId: WorkspaceId, now: Date = new Date()): SweepResult {
    const at = now.toISOString();
    return this.db.transaction((): SweepResult => {
      // A11's surface: this note closed a trusted note after its last human confirmation.
      const rows = this.db
        .prepare(
          `SELECT e.id, e.scope, e.trust, e.version, e.observed_at, e.effective_at,
                  e.last_confirmed_at, e.ttl_seconds,
                  EXISTS (SELECT 1 FROM memory_supersessions s
                            JOIN memory_entries l ON l.id = s.entry_id
                           WHERE s.workspace_id = e.workspace_id AND s.winner_id = e.id
                             AND l.trust = 'trusted' AND s.reason <> 'undo_restore'
                             AND s.created_at > COALESCE(e.last_confirmed_at, '')) AS replaced_trusted
             FROM memory_entries e
            WHERE e.workspace_id = ? AND e.kind = 'note' AND e.scope IN ('workspace', 'bot')
              AND e.tombstoned = 0 AND e.invalid_at IS NULL AND e.episode_id IS NULL`,
        )
        .all(workspaceId) as CandidateRow[];
      const open = new Map(
        (
          this.db
            .prepare(
              "SELECT * FROM memory_revalidations WHERE workspace_id = ? AND status = 'open'",
            )
            .all(workspaceId) as FlagRow[]
        ).map((row) => [row.entry_id, row]),
      );
      const dismissed = this.db.prepare(
        `SELECT 1 FROM memory_revalidations
          WHERE entry_id = ? AND entry_version = ? AND reason = ? AND status = 'dismissed'`,
      );
      const result: SweepResult = { flagged: 0, updated: 0, closed: 0 };
      const keep = new Set<string>();
      for (const row of rows) {
        const reasons = memoryFreshness(
          {
            scope: row.scope,
            kind: "note",
            trust: row.trust,
            tombstoned: false,
            observedAt: row.observed_at,
            effectiveAt: row.effective_at ?? row.observed_at,
            ...(row.last_confirmed_at ? { lastConfirmedAt: row.last_confirmed_at } : {}),
            ...(row.ttl_seconds ? { ttlSeconds: row.ttl_seconds } : {}),
            replacedTrusted: row.replaced_trusted === 1,
          },
          now,
          this.policy,
        );
        // A27: a dismissal holds for that note version and reason.
        const reason = reasons.find((r) => !dismissed.get(row.id, row.version, r));
        if (!reason) continue;
        keep.add(row.id);
        const flag = open.get(row.id);
        if (flag) {
          if (flag.reason !== reason) {
            this.db
              .prepare("UPDATE memory_revalidations SET reason = ?, entry_version = ? WHERE id = ?")
              .run(reason, row.version, flag.id);
            result.updated += 1;
          }
          continue;
        }
        this.db
          .prepare(
            `INSERT INTO memory_revalidations
               (id, workspace_id, entry_id, entry_version, reason, horizon_days, flagged_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            newId("mrv"),
            workspaceId,
            row.id,
            row.version,
            reason,
            horizon(row.scope, this.policy),
            at,
          );
        result.flagged += 1;
      }
      for (const flag of open.values()) {
        if (keep.has(flag.entry_id)) continue;
        const entry = this.entries.get(flag.entry_id);
        const outcome: MemoryRevalidationOutcome = !entry
          ? "forgotten"
          : entry.tombstoned
            ? "forgotten"
            : entry.invalidAt !== undefined
              ? "superseded"
              : "resolved";
        this.close(flag.id, outcome, SYSTEM, at);
        result.closed += 1;
      }
      this.db
        .prepare(
          `INSERT INTO memory_freshness_sweeps (workspace_id, swept_at) VALUES (?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET swept_at = excluded.swept_at`,
        )
        .run(workspaceId, at);
      return result;
    })();
  }

  /**
   * The scheduler's periodic pass (A26): sweep workspaces with notes that were not swept in the
   * last hour, a bounded number per pass. A failure is reported, never thrown into the pass.
   */
  sweepDue(now: Date = new Date(), log: (message: string) => void = () => {}): number {
    try {
      const since = new Date(now.getTime() - FRESHNESS_SWEEP_INTERVAL_MS).toISOString();
      const due = this.db
        .prepare(
          `SELECT DISTINCT e.workspace_id AS id FROM memory_entries e
            WHERE e.kind = 'note' AND e.tombstoned = 0
              AND NOT EXISTS (SELECT 1 FROM memory_freshness_sweeps s
                               WHERE s.workspace_id = e.workspace_id AND s.swept_at > ?)
            LIMIT ?`,
        )
        .all(since, SWEEPS_PER_PASS) as { id: WorkspaceId }[];
      for (const { id } of due) this.sweep(id, now);
      return due.length;
    } catch (error) {
      log(`memory freshness sweep failed: ${String(error)}`);
      return 0;
    }
  }

  /** One page of open flags, `flagged_at DESC, id DESC`, with exact totals per reason. */
  page(
    workspaceId: WorkspaceId,
    page: { limit: number; after?: readonly [string, string]; needsHuman?: boolean },
  ): {
    items: MemoryRevalidation[];
    more: boolean;
    total: number;
    needsHuman: number;
    byReason: Partial<Record<MemoryFreshnessReason, number>>;
  } {
    const after = page.after;
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_revalidations
          WHERE workspace_id = ? AND status = 'open' ${page.needsHuman ? `AND ${NEEDS_HUMAN_SQL}` : ""}
            AND (? IS NULL OR flagged_at < ? OR (flagged_at = ? AND id < ?))
          ORDER BY flagged_at DESC, id DESC LIMIT ?`,
      )
      .all(
        workspaceId,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[0] ?? null,
        after?.[1] ?? null,
        page.limit + 1,
      ) as FlagRow[];
    const counts = this.db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM memory_revalidations
          WHERE workspace_id = ? AND status = 'open' GROUP BY reason`,
      )
      .all(workspaceId) as { reason: MemoryFreshnessReason; n: number }[];
    const byReason: Partial<Record<MemoryFreshnessReason, number>> = {};
    for (const { reason, n } of counts) byReason[reason] = n;
    const needsHuman = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM memory_revalidations
            WHERE workspace_id = ? AND status = 'open' AND ${NEEDS_HUMAN_SQL}`,
        )
        .get(workspaceId) as { n: number }
    ).n;
    return {
      items: rows.slice(0, page.limit).map((row) => this.view(row)),
      more: rows.length > page.limit,
      total: counts.reduce((sum, { n }) => sum + n, 0),
      needsHuman,
      byReason,
    };
  }

  /** An open or decided flag of this workspace; another workspace's flag is not found. */
  get(workspaceId: WorkspaceId, id: string): MemoryRevalidation {
    const row = this.db
      .prepare("SELECT * FROM memory_revalidations WHERE id = ? AND workspace_id = ?")
      .get(id, workspaceId) as FlagRow | undefined;
    if (!row) throw new DeskmatesError("not_found", "Revalidation not found", { id });
    return this.view(row);
  }

  /**
   * A27: a human answers an open flag. `still_true` renews the note's confirmation time with a
   * `confirm` version, trust unchanged; `dismiss` changes no note. Audited in the same write.
   */
  decide(
    audit: AuditLog,
    input: {
      workspaceId: WorkspaceId;
      id: string;
      decision: unknown;
      by: string;
    },
    now: Date = new Date(),
  ): MemoryRevalidation {
    if (input.decision !== "still_true" && input.decision !== "dismiss")
      throw new DeskmatesError("validation", "Expected still_true or dismiss", {
        field: "decision",
      });
    const decision = input.decision as MemoryRevalidationDecision;
    return this.db.transaction(() => {
      const flag = this.get(input.workspaceId, input.id);
      if (flag.status !== "open")
        throw new DeskmatesError("invalid_transition", "This revalidation was already answered");
      const entry = this.entries.mustGetIn(input.workspaceId, flag.entryId);
      if (entry.tombstoned || entry.invalidAt !== undefined)
        throw new DeskmatesError("invalid_transition", "The note is no longer current");
      const at = now.toISOString();
      let version = entry.version;
      if (decision === "still_true") {
        version = this.entries.appendVersion(
          entry.id,
          "confirm",
          { lastConfirmedAt: at },
          input.by,
        ).version;
      }
      this.db
        .prepare("UPDATE memory_revalidations SET entry_version = ? WHERE id = ?")
        .run(decision === "dismiss" ? entry.version : flag.entryVersion, flag.id);
      this.close(flag.id, decision === "still_true" ? "still_true" : "dismissed", input.by, at);
      audit.record({
        action: "memory.revalidate",
        actor: input.by,
        workspaceId: input.workspaceId,
        targetKind: "memory_entry",
        targetId: entry.id,
        after: { decision, reason: flag.reason, flag: flag.id, version },
      });
      return this.get(input.workspaceId, flag.id);
    })();
  }

  private close(id: string, outcome: MemoryRevalidationOutcome, by: string, at: string): void {
    this.db
      .prepare(
        "UPDATE memory_revalidations SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?",
      )
      .run(outcome, by, at, id);
  }

  private view(row: FlagRow): MemoryRevalidation {
    const entry = this.entries.mustGet(row.entry_id);
    return {
      id: row.id,
      workspaceId: row.workspace_id as WorkspaceId,
      entryId: row.entry_id,
      entryVersion: row.entry_version,
      reason: row.reason,
      status: row.status,
      flaggedAt: row.flagged_at,
      horizonDays: row.horizon_days,
      ...(row.decided_by ? { decidedBy: row.decided_by } : {}),
      ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
      ...(row.model_verdict && row.model_checked_at
        ? {
            model: {
              verdict: row.model_verdict,
              reason: row.model_reason ?? "",
              checkedAt: row.model_checked_at,
              runId: row.model_run_id ?? "",
              entryVersion: row.model_entry_version ?? row.entry_version,
            },
          }
        : {}),
      needsHuman: row.reason === "replaced_trusted" || row.model_verdict === "possibly_stale",
      entry: {
        body: entry.body,
        scope: entry.scope === "bot" ? "bot" : "workspace",
        trust: entry.trust,
        ...(entry.botId ? { botId: entry.botId } : {}),
        version: entry.version,
        effectiveAt: entry.effectiveAt,
        ...(entry.lastConfirmedAt ? { lastConfirmedAt: entry.lastConfirmedAt } : {}),
        ...(entry.ttlSeconds ? { ttlSeconds: entry.ttlSeconds } : {}),
        ...(entry.learnedBy ? { learnedBy: entry.learnedBy } : {}),
        ...(entry.sourceRunId ? { sourceRunId: entry.sourceRunId } : {}),
      },
    };
  }
}
