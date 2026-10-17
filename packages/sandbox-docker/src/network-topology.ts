// Read-only network facts for ADR-0027 amendment 2: the daemon's IPv4 subnets (decision 15) and
// whether a cached workspace container still has the topology attach accepts (decision 16).

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
