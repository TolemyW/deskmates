// Host resources (ADR-0006 amendment 5, issue #14): what the sandbox provider owns on its host,
// classified against `workspaces` (decision 12) on start and on request, and the root's one
// action per finding (decision 13), each an audit row. Pool headroom (decision 14) is reported
// in the same pass, warned about at start and kept for `GET /api/runtime`.

import {
  type AddressPoolHeadroom,
  DeskmatesError,
  type HostResourceAction,
  type HostResourceActionResult,
  type HostResourceFinding,
  type HostResourceReport,
  type HostResourceTarget,
  type KnownWorkspace,
  type WorkspaceId,
  addressPoolHeadroom,
  classifyHostResources,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";

/** The last pool headroom this Gateway saw, for `GET /api/runtime` (decision 14). */
const lastPools = new WeakMap<GatewayContext, AddressPoolHeadroom>();

export function lastAddressPools(ctx: GatewayContext): AddressPoolHeadroom | undefined {
  return lastPools.get(ctx);
}

function knownWorkspace(ctx: GatewayContext, id: string): KnownWorkspace | undefined {
  let workspace: ReturnType<GatewayContext["workspaces"]["mustGetIncludingArchived"]>;
  try {
    workspace = ctx.workspaces.mustGetIncludingArchived(id as WorkspaceId);
  } catch {
    return undefined;
  }
  return {
    name: workspace.name,
    archived: workspace.archivedAt !== undefined,
    liveRuns: ctx.runs.listLiveInWorkspace(workspace.id).length,
  };
}

/** Decision 12: list, classify, measure the pools. Changes nothing. */
export async function hostResourceReport(ctx: GatewayContext): Promise<HostResourceReport> {
  const checkedAt = new Date().toISOString();
  if (ctx.provider.listHostResources === undefined)
    return { checked: false, checkedAt, findings: [], healthy: 0 };
  try {
    const inventory = await ctx.provider.listHostResources();
    const { findings, healthy } = classifyHostResources(inventory, (id) => knownWorkspace(ctx, id));
    const pool = addressPoolHeadroom(inventory.addressPools, inventory.subnets);
    lastPools.set(ctx, pool);
    return { checked: true, checkedAt, findings, healthy, pool };
  } catch (error) {
    return { checked: false, checkedAt, findings: [], healthy: 0, error: String(error) };
  }
}

/** One startup line for a low or exhausted pool, like the LAN overlap warning. */
export function poolWarning(pool: AddressPoolHeadroom): string | undefined {
  if (pool.status !== "low" && pool.status !== "exhausted") return undefined;
  const pools = pool.pools.map((p) => `${p.base}/${p.size}`).join(", ");
  return `Docker address pools ${pool.status}: ${pool.free} of ${pool.capacity} networks free (${pool.source === "daemon" ? "configured" : "Docker's defaults"}: ${pools}); every workspace needs one, and creating one fails when none is left. Set default-address-pools in the daemon config.`;
}

/**
 * The Gateway's startup pass: the pool warning and one line naming the findings. Never throws
 * and never blocks startup.
 */
export async function reportHostResources(
  ctx: GatewayContext,
  warn: (message: string) => void,
): Promise<HostResourceReport> {
  const report = await hostResourceReport(ctx);
  if (!report.checked) {
    if (report.error !== undefined) warn(`Host resources not checked: ${report.error}`);
    return report;
  }
  const pool = report.pool === undefined ? undefined : poolWarning(report.pool);
  if (pool !== undefined) warn(pool);
  if (report.findings.length > 0) {
    const counts = new Map<string, number>();
    for (const f of report.findings) counts.set(f.flag, (counts.get(f.flag) ?? 0) + 1);
    const summary = [...counts].map(([flag, n]) => `${n} ${flag}`).join(", ");
    warn(
      `Host resources: ${report.findings.length} finding(s) (${summary}); the root can review them on the Network page under Host resources`,
    );
  }
  return report;
}

function targetOf(finding: HostResourceFinding): HostResourceTarget {
  if (finding.flag === "legacy_network") {
    const network = finding.resources[0];
    if (network === undefined) throw new Error(`finding ${finding.id} names no network`);
    return { kind: "network", name: network.name };
  }
  if (finding.workspaceId === undefined) throw new Error(`finding ${finding.id} has no workspace`);
  return {
    kind: "workspace",
    workspaceId: finding.workspaceId,
    keepVolumes: finding.flag === "archived",
  };
}

/** Who acts: the ledger label and the tenant the audit row belongs to when no workspace does. */
export interface HostResourceActor {
  by: string;
  tenantId: string;
}

/**
 * Decision 13: classify again, act only on a finding that is still present and offers this
 * action, refuse while a run is live, and record the outcome (success or failure) as one audit
 * row. A known workspace's sandbox handle is dropped, so the next use attaches afresh.
 */
export async function actOnHostResource(
  ctx: GatewayContext,
  action: HostResourceAction,
  findingId: string,
  actor: HostResourceActor,
): Promise<HostResourceActionResult> {
  const before = await hostResourceReport(ctx);
  if (!before.checked)
    throw new DeskmatesError("sandbox_unavailable", "the sandbox provider cannot list its host", {
      reason: "host_resources_unavailable",
      ...(before.error === undefined ? {} : { error: before.error }),
    });
  const finding = before.findings.find((f) => f.id === findingId);
  if (finding === undefined)
    throw new DeskmatesError("not_found", `no host-resource finding ${findingId}`, { findingId });
  if (finding.action !== action)
    throw new DeskmatesError(
      "validation",
      `finding ${findingId} offers ${finding.action ?? "no action"}, not ${action}`,
      { findingId, reason: "action_not_offered" },
    );
  if (finding.blocked !== undefined)
    throw new DeskmatesError("invalid_transition", `refused: ${finding.blocked}`, {
      findingId,
      reason: "run_live",
    });
  const workspaceId =
    finding.workspaceId !== undefined && knownWorkspace(ctx, finding.workspaceId) !== undefined
      ? (finding.workspaceId as WorkspaceId)
      : undefined;
  const record = (after: Record<string, unknown>, reason?: string) =>
    ctx.audit.record({
      action: action === "remove" ? "host_resource.remove" : "host_resource.reattach",
      actor: actor.by,
      ...(workspaceId === undefined ? { tenantId: actor.tenantId } : { workspaceId }),
      targetKind: "host_resource",
      targetId: findingId,
      before: {
        flag: finding.flag,
        resources: finding.resources.map((r) => `${r.kind}:${r.name}`),
      },
      after,
      ...(reason === undefined ? {} : { reason: reason.slice(0, 500) }),
    });
  const perform = async (): Promise<Omit<HostResourceActionResult, "report">> => {
    // Again under the workspace's lifecycle gate: a run may have started since the report.
    if (workspaceId !== undefined && ctx.runs.listLiveInWorkspace(workspaceId).length > 0)
      throw new DeskmatesError("invalid_transition", "refused: a run is live in the workspace", {
        findingId,
        reason: "run_live",
      });
    if (action === "remove") {
      const remove = ctx.provider.removeHostResources;
      if (remove === undefined) throw unsupported(action);
      const removed = await remove.call(ctx.provider, targetOf(finding));
      return { findingId, action, removed };
    }
    const reattach = ctx.provider.reattachWorkspaceNetwork;
    if (reattach === undefined || finding.workspaceId === undefined) throw unsupported(action);
    const { problem } = await reattach.call(ctx.provider, finding.workspaceId as WorkspaceId);
    return {
      findingId,
      action,
      repaired: problem === undefined,
      ...(problem === undefined ? {} : { problem }),
    };
  };
  let outcome: Omit<HostResourceActionResult, "report">;
  try {
    outcome =
      finding.workspaceId === undefined
        ? await perform()
        : await ctx.sandboxes.withPolicyUpdate(finding.workspaceId as WorkspaceId, async () => {
            const result = await perform();
            ctx.sandboxes.forget(finding.workspaceId as string);
            return result;
          });
  } catch (error) {
    record({ status: "failed" }, String(error));
    throw error;
  }
  record({
    status: outcome.repaired === false ? "not_repaired" : "done",
    ...(outcome.removed ? { removed: outcome.removed.map((r) => `${r.kind}:${r.name}`) } : {}),
    ...(outcome.problem === undefined ? {} : { problem: outcome.problem }),
  });
  return { ...outcome, report: await hostResourceReport(ctx) };
}

function unsupported(action: HostResourceAction): DeskmatesError {
  return new DeskmatesError("sandbox_unavailable", `the sandbox provider cannot ${action}`, {
    reason: "host_resources_unavailable",
  });
}
