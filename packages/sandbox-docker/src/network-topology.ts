// Read-only network facts for ADR-0027 amendment 2: the daemon's IPv4 subnets (decision 15) and
// whether a cached workspace container still has the topology attach accepts (decision 16); and
// for ADR-0006 amendment 5 decision 11, which networks a former product name left behind.

import { type SandboxNetworkSubnet, parseIpv4Cidr } from "@deskmates/contracts";

/** The `/networks` list shape, as far as subnets go. */
export interface NetworkSummary {
  Name: string;
  IPAM?: { Config?: { Subnet?: string }[] | null } | null;
}

/** Every IPv4 subnet of every network, sorted by network name; IPv6 and empty configs skipped. */
export function networkSubnetsOf(networks: readonly NetworkSummary[]): SandboxNetworkSubnet[] {
  const subnets: SandboxNetworkSubnet[] = [];
  for (const network of networks)
    for (const config of network.IPAM?.Config ?? [])
      if (config.Subnet !== undefined && parseIpv4Cidr(config.Subnet) !== undefined)
        subnets.push({ name: network.Name, cidr: config.Subnet });
  return subnets.sort((a, b) => a.name.localeCompare(b.name) || a.cidr.localeCompare(b.cidr));
}

/** The part of a container inspect the topology rules read. */
export interface TopologyInspect {
  Config: { Labels?: Record<string, string> };
  HostConfig?: { ExtraHosts?: string[]; NetworkMode?: string };
  NetworkSettings: { Networks?: Record<string, unknown> };
}

export interface ExpectedTopology {
  /** Labels the container must carry with exactly these values. */
  labels: Readonly<Record<string, string>>;
  /** The one network the container is attached to, also its network mode. */
  network: string;
  /** A name the container must not resolve directly through `ExtraHosts`. */
  hostAlias: string;
}

/** Why a cached workspace container no longer has attach's topology, or undefined if it does. */
export function topologyProblem(
  inspect: TopologyInspect,
  expected: ExpectedTopology,
): string | undefined {
  const labels = inspect.Config.Labels ?? {};
  if (Object.entries(expected.labels).some(([key, value]) => labels[key] !== value))
    return "workspace container labels changed";
  if (
    inspect.HostConfig?.ExtraHosts?.some((entry) =>
      entry.toLowerCase().startsWith(`${expected.hostAlias}:`),
    )
  )
    return "workspace has a direct host alias";
  const names = Object.keys(inspect.NetworkSettings.Networks ?? {});
  if (
    names.length !== 1 ||
    names[0] !== expected.network ||
    inspect.HostConfig?.NetworkMode !== expected.network
  )
    return "workspace is attached to a legacy or mismatched network";
  return undefined;
}

/** The `/networks` list or inspect shape, as far as the former-name rule goes. */
export interface NamedNetwork {
  Name: string;
  Labels?: Record<string, string> | null;
}

/** The workspace ids the Gateway mints: `ws_` and 32 hex digits (`db/ids.ts` `newId`). */
const GATEWAY_WORKSPACE_ID = /^ws_[0-9a-f]{32}$/;

/**
 * ADR-0006 amendment 5 decision 11: a network this provider's naming rule made under another
 * product prefix. The rule is the provider's own (`networkName`, `EGRESS_OUTBOUND_NETWORK` and
 * their labels) with the prefix left open, so no former product name is written here:
 * `<prefix>-net-<id>` labelled `<prefix>.managed=true` and `<prefix>.workspace=<id>`, or named
 * after a Gateway workspace id when it predates the labels; `<prefix>-egress-outbound` labelled
 * `<prefix>.managed=true`. Undefined for this provider's own prefix and anything else.
 */
export function formerNameNetwork(
  network: NamedNetwork,
  ownPrefix: string,
): { prefix: string; workspaceId?: string } | undefined {
  const labels = network.Labels ?? {};
  const outbound = /^([a-z][a-z0-9]*)-egress-outbound$/.exec(network.Name);
  if (outbound?.[1] !== undefined && outbound[1] !== ownPrefix)
    return labels[`${outbound[1]}.managed`] === "true" ? { prefix: outbound[1] } : undefined;
  const match = /^([a-z][a-z0-9]*)-net-(.+)$/.exec(network.Name);
  const prefix = match?.[1];
  const suffix = match?.[2];
  if (prefix === undefined || suffix === undefined || prefix === ownPrefix) return undefined;
  const labelled = labels[`${prefix}.workspace`];
  if (labels[`${prefix}.managed`] === "true" && labelled) return { prefix, workspaceId: labelled };
  return GATEWAY_WORKSPACE_ID.test(suffix) ? { prefix, workspaceId: suffix } : undefined;
}
