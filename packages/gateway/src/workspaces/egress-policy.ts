// The one way a workspace's allowlist changes at run time: an operator edit (PATCH) or an egress
// approval answered "allow this site" (ADR-0020). Both push the new list to the proxy before the
// row is written, tell every live run what changed, and publish the workspace on the bus.

import {
  type Approval,
  type ApprovalDecision,
  type ApprovalId,
  DeskmatesError,
  EGRESS_OPEN_INTERNET,
  type Workspace,
  type WorkspaceId,
  egressAllowlistProblem,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { assertNoGrantsOnOpenInternet, networkProfiles } from "../network/network-policy.js";

/** Network policy updates are acknowledged before the new list is committed. */
export const EGRESS_EDIT_NOTE =
  "The network proxy applies the new list immediately and closes existing connections. The sidecar hook refreshes the list on the next navigation.";

export async function replaceEgressAllowlist(
  ctx: GatewayContext,
  id: WorkspaceId,
  patterns: readonly string[],
  by: string,
): Promise<{ workspace: Workspace; added: string[]; removed: string[] }> {
  // The same rule as create: `*` (open internet, ADR-0010) is valid only on its own. Checked
  // here too because the proxy is updated before the row is written.
  const problem = egressAllowlistProblem(patterns);
  if (problem !== undefined) throw new DeskmatesError("validation", problem);
  const { workspace, before } = await ctx.sandboxes.withPolicyUpdate(id, async (peek) => {
    const current = ctx.workspaces.mustGet(id);
    // ADR-0027 amendment 1 decision 13, checked under the same lock a profile selection takes.
    assertNoGrantsOnOpenInternet(ctx, id, patterns);
    // The proxy document carries the workspace's network-profile grants with the allowlist; an
    // allowlist edit republishes them unchanged rather than dropping them.
    const grants = networkProfiles(ctx).grantsFor(id);
    const handle = await peek();
    if (handle) await ctx.provider.updateEgress(handle, patterns, grants);
    try {
      return {
        workspace: ctx.workspaces.setEgressAllowlist(id, patterns, by),
        before: current.egressAllowlist,
      };
    } catch (error) {
      if (handle) await ctx.provider.updateEgress(handle, current.egressAllowlist, grants);
      throw error;
    }
  });
  const after = workspace.egressAllowlist;
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  for (const run of ctx.runs.listLiveInWorkspace(id)) {
    ctx.events.append({
      runId: run.id,
      kind: "log",
      payload: { source: "egress", op: "allowlist_replaced", by, added, removed },
    });
  }
  ctx.bus.publish({ type: "workspace", workspaceId: id, workspace });
  return { workspace, added, removed };
}

/** The host an egress approval asks for, from the action's origin. */
export function egressHostOf(approval: Approval): string | undefined {
  const origin = approval.action.targetOrigin;
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * ADR-0020 decision 2: before an egress approval is settled with `allow_always`, its host joins
 * the workspace allowlist, so the proxy already admits the site when the run continues. A deny,
 * a tool approval or an already-decided approval changes nothing here. Returns the host and
 * workspace when this call added the host.
 */
export async function applyEgressDecision(
  ctx: GatewayContext,
  approvalId: ApprovalId,
  decision: ApprovalDecision,
  by: string,
): Promise<{ workspaceId: WorkspaceId; host: string } | undefined> {
  const approval = ctx.approvals.mustGet(approvalId);
  if (approval.kind !== "egress" || approval.decision !== undefined) return undefined;
  if (decision !== "allow_always") return undefined;
  const host = egressHostOf(approval);
  if (host === undefined) {
    throw new DeskmatesError("validation", "the egress approval names no host", { approvalId });
  }
  const workspaceId = ctx.bots.mustGet(approval.botId).workspaceId;
  const current = ctx.workspaces.mustGet(workspaceId).egressAllowlist;
  if (current.includes(EGRESS_OPEN_INTERNET) || current.some((p) => p.toLowerCase() === host))
    return undefined;
  const { added } = await replaceEgressAllowlist(ctx, workspaceId, [...current, host], by);
  return added.includes(host) ? { workspaceId, host } : undefined;
}

/**
 * Settle an approval with its egress side: the host of an "allow this site" joins the list
 * first (decision 2), then `decide` records the answer. When `decide` fails, for instance because
 * another answer landed while the proxy was being updated, a host this call added is taken out
 * again unless the approval ended allowed, so a deny never leaves the site admitted.
 */
export async function decideWithEgress<T>(
  ctx: GatewayContext,
  approvalId: ApprovalId,
  decision: ApprovalDecision,
  by: string,
  decide: () => T,
): Promise<T> {
  const added = await applyEgressDecision(ctx, approvalId, decision, by);
  try {
    return decide();
  } catch (error) {
    if (added !== undefined && ctx.approvals.get(approvalId)?.decision !== "allow_always") {
      const current = ctx.workspaces.mustGet(added.workspaceId).egressAllowlist;
      if (current.includes(added.host))
        await replaceEgressAllowlist(
          ctx,
          added.workspaceId,
          current.filter((p) => p !== added.host),
          by,
        );
    }
    throw error;
  }
}
