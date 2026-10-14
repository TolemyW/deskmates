// Connectivity preflight for one URL (ADR-0027 amendment 1 decision 14): the policy verdict the
// hook and proxy would reach, then DNS, TCP, TLS and the HTTP response probed from the
// workspace's proxy. No model call, nothing persisted, no policy change.

import {
  type NetworkPreflightResult,
  type WorkspaceId,
  egressAllows,
  networkGrantFor,
  networkTarget,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { networkProfiles } from "./network-policy.js";

function finish(result: Omit<NetworkPreflightResult, "failedLayer">): NetworkPreflightResult {
  const failed = result.layers.find((l) => !l.ok);
  return { ...result, ...(failed === undefined ? {} : { failedLayer: failed.layer }) };
}

export async function preflightWorkspaceNetwork(
  ctx: GatewayContext,
  workspaceId: WorkspaceId,
  url: string,
): Promise<NetworkPreflightResult> {
  const workspace = ctx.workspaces.mustGet(workspaceId);
  const target = networkTarget(url);
  if (target === undefined)
    return finish({
      url,
      ok: false,
      layers: [{ layer: "policy", ok: false, detail: "not an http(s) URL without credentials" }],
    });
  const grant = networkGrantFor(networkProfiles(ctx).grantsFor(workspaceId), target);
  const standardPort = target.port === (target.scheme === "http" ? 80 : 443);
  const allowlisted = standardPort && egressAllows(target.host, workspace.egressAllowlist);
  if (grant === undefined && !allowlisted)
    return finish({
      url,
      ok: false,
      layers: [
        {
          layer: "policy",
          ok: false,
          detail: standardPort
            ? `${target.host} is not in the allowlist and no selected network profile grants ${target.scheme}://${target.host}:${target.port}`
            : `no selected network profile grants ${target.scheme}://${target.host}:${target.port}`,
        },
      ],
    });
  const admittedBy = grant === undefined ? "allowlist" : "grant";
  const policy = { layer: "policy" as const, ok: true, detail: `admitted by ${admittedBy}` };
  const handle = await ctx.sandboxes.peek(workspaceId);
  if (handle === undefined || ctx.provider.probeEgress === undefined)
    return finish({
      url,
      admittedBy,
      ok: true,
      layers: [
        {
          ...policy,
          detail: `${policy.detail}; network layers not checked: ${handle === undefined ? "the workspace is not running" : "the sandbox provider cannot probe"}`,
        },
      ],
    });
  const probe = await ctx.provider.probeEgress(handle, {
    url,
    grant: grant !== undefined,
    ...(grant?.kind === "host" ? { address: grant.address } : {}),
  });
  return finish({
    url,
    admittedBy,
    ok: probe.ok,
    layers: [policy, ...probe.layers],
    ...(probe.status === undefined ? {} : { status: probe.status }),
  });
}
