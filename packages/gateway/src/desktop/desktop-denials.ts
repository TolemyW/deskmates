// ADR-0048 amendment 1, A4 (owner, 2026-10-17: deny-not-ask accepted, "但是要记录"): a desktop
// call refused for a network target its code names leaves a `desktop`/`egress_denied` event in
// the run's ledger, written by the sidecar's hook. When the Gateway stores that event it appends
// one `egress.desktop_denied` audit row, the record an ask would otherwise have left. The URL is
// never recorded, only its host: a URL may carry a token.

import type { RunEvent } from "@deskmates/contracts";
import { AuditLog } from "../audit/audit-log.js";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";

const KINDS: ReadonlySet<unknown> = new Set(["hard_deny", "not_in_allowlist", "unreadable"]);

function bounded(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value !== "" ? value.slice(0, max) : undefined;
}

/** Whether a ledger event is a recorded desktop network denial. */
export function isDesktopDenial(event: Pick<RunEvent, "kind" | "payload">): boolean {
  return (
    event.kind === "log" &&
    event.payload.source === "desktop" &&
    event.payload.op === "egress_denied"
  );
}

/** One audit row per stored denial; a failure here never fails the event batch. */
export function recordDesktopDenials(
  ctx: Pick<GatewayContext, "db" | "bots">,
  run: Pick<RunRecord, "id" | "botId">,
  stored: readonly Pick<RunEvent, "kind" | "payload">[],
): void {
  const denials = stored.filter(isDesktopDenial);
  if (denials.length === 0) return;
  const workspaceId = ctx.bots.mustGetIncludingArchived(run.botId).workspaceId;
  const audit = new AuditLog(ctx.db);
  for (const event of denials) {
    const p = event.payload;
    try {
      const toolName = bounded(p.toolName, 200);
      const toolUseId = bounded(p.toolUseId, 200);
      const reason = bounded(p.reason, 500);
      audit.record({
        action: "egress.desktop_denied",
        actor: `bot:${run.botId}`,
        workspaceId,
        targetKind: "egress_host",
        targetId: bounded(p.host, 253) ?? "(no host)",
        runId: run.id,
        ...(reason === undefined ? {} : { reason }),
        after: {
          kind: KINDS.has(p.kind) ? p.kind : "unknown",
          ...(toolName === undefined ? {} : { toolName }),
          ...(toolUseId === undefined ? {} : { toolUseId }),
        },
      });
    } catch {
      // The ledger event is the primary record; the audit copy must not drop the batch.
    }
  }
}
