// The `approve_all` mode's egress step (ADR-0002 amendment 6, D4). An egress ask in a locked
// workspace is allowed by the mode only after its host joins the allowlist through the one
// existing answered-ask writer (`replaceEgressAllowlist`, the same path as "Allow this site"), so
// the proxy admits the site by the time the run continues. A host the list cannot take, an IP
// literal or a private name among them, is not added and the ask goes to humans. The hard denies
// themselves happen in the sidecar before any ask exists (D5); this check is a second line.

import {
  APPROVAL_MODE_ACTOR,
  type ApprovalRequest,
  EGRESS_OPEN_INTERNET,
  isPublicHostname,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import type { RunRecord } from "../ledger/runs.js";
import { replaceEgressAllowlist } from "../workspaces/egress-policy.js";
import { AutoApprovalSettings } from "./auto-approval.js";

/** The host an egress ask names, from its target origin. */
function hostOf(req: ApprovalRequest): string | undefined {
  const origin = req.action.targetOrigin;
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Before the broker sees a new egress ask: in `approve_all`, add its host to the workspace
 * allowlist as `mode:approve_all`. True when the host is on the list afterwards, which lets the
 * broker record the ask as allowed by the mode; false leaves the ask to the usual path.
 */
export async function allowEgressForApproveAll(
  ctx: GatewayContext,
  run: RunRecord,
  req: ApprovalRequest,
): Promise<boolean> {
  if (req.kind !== "egress" || ctx.approvals.get(req.approvalId)) return false;
  const workspaceId = ctx.bots.mustGet(run.botId).workspaceId;
  if (new AutoApprovalSettings(ctx.db).mode(workspaceId) !== "approve_all") return false;
  const host = hostOf(req);
  if (host === undefined || !isPublicHostname(host)) return false;
  const current = ctx.workspaces.mustGet(workspaceId).egressAllowlist;
  if (current.includes(EGRESS_OPEN_INTERNET) || current.some((p) => p.toLowerCase() === host))
    return true;
  try {
    await replaceEgressAllowlist(ctx, workspaceId, [...current, host], APPROVAL_MODE_ACTOR);
    return true;
  } catch (error) {
    ctx.events.append({
      runId: run.id,
      kind: "log",
      payload: { source: "approval_mode", op: "egress_add_failed", host, error: String(error) },
    });
    return false;
  }
}
