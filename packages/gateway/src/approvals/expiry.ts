// Unattended approval requests (ADR-0002 amendment 3, A7 and A8). The scheduler's periodic pass
// calls `sweep`: a tool or egress request nobody decided within its workspace's
// `approval_expiry_minutes` is denied as `system:expiry`, and once, when a third of that window
// is left, a routing-inert reminder reaches the humans. Continuation requests keep ADR-0016's
// 24-hour window and are not touched here.

import type { ApprovalId } from "@deskmates/contracts";
import { nowIso } from "../db/ids.js";
import type { GatewayDb } from "../db/open.js";
import type { ApprovalBroker } from "./broker.js";

/** The `decided_by` of an expiry, shared with ADR-0016's continuation window. */
export const APPROVAL_EXPIRY_ACTOR = "system:expiry";
/** A8: the reminder goes out when this share of the window is left (a proposed guess). */
export const REMINDER_WINDOW_FRACTION = 1 / 3;

/** What the model is told, live or on resume (A7). */
export function expiryReason(minutes: number): string {
  return `Nobody approved this within ${minutes} minute${minutes === 1 ? "" : "s"}. It was not done. Do not try to reach the same effect another way; report what is blocked, then continue with other work or end.`;
}

interface PendingRow {
  id: ApprovalId;
  created_at: string;
  reminded_at: string | null;
  expiry_minutes: number;
}

export interface SweepResult {
  expired: ApprovalId[];
  reminded: ApprovalId[];
}

export class ApprovalExpiry {
  constructor(private readonly deps: { db: GatewayDb; broker: ApprovalBroker }) {}

  sweep(now: Date = new Date()): SweepResult {
    const rows = this.deps.db
      .prepare(
        `SELECT a.id, a.created_at, a.reminded_at, w.approval_expiry_minutes AS expiry_minutes
           FROM approvals a JOIN workspaces w ON w.id = a.workspace_id
          WHERE a.decision IS NULL AND a.kind != 'continuation'
          ORDER BY a.created_at, a.id`,
      )
      .all() as PendingRow[];
    const result: SweepResult = { expired: [], reminded: [] };
    for (const row of rows) {
      const windowMs = row.expiry_minutes * 60_000;
      const left = windowMs - (now.getTime() - Date.parse(row.created_at));
      if (left <= 0) {
        if (this.deps.broker.expire(row.id, row.expiry_minutes)) result.expired.push(row.id);
        continue;
      }
      if (row.reminded_at !== null || left > windowMs * REMINDER_WINDOW_FRACTION) continue;
      // Claim the reminder first, so a second sweep, or a restart, never sends another.
      const claimed = this.deps.db
        .prepare(
          "UPDATE approvals SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL AND decision IS NULL",
        )
        .run(nowIso(), row.id);
      if (claimed.changes !== 1) continue;
      this.deps.broker.remind(row.id, Math.max(1, Math.ceil(left / 60_000)));
      result.reminded.push(row.id);
    }
    return result;
  }
}
