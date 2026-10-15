// Docker/LAN subnet overlap (ADR-0027 amendment 2 decision 15): every LAN target the Gateway
// knows, compared with the subnets of the sandbox provider's networks. Advisory: reported at
// startup, to the root and in the preflight's `route` layer; nothing is refused or changed.

import {
  type LanTarget,
  type NetworkOverlap,
  type SandboxNetworkSubnet,
  findNetworkOverlaps,
} from "@deskmates/contracts";
import type { GatewayContext } from "../context.js";
import { networkProfiles } from "./network-policy.js";

export interface NetworkOverlapReport {
  /** False when the provider cannot list its networks; nothing was compared then. */
  checked: boolean;
  networks: SandboxNetworkSubnet[];
  overlaps: NetworkOverlap[];
}

/** Profile rules, `EGRESS_PRIVATE_TARGETS` addresses and `NETWORK_LAN_CIDRS`, in that order. */
export function lanTargets(ctx: GatewayContext): LanTarget[] {
  const targets: LanTarget[] = [];
  for (const profile of networkProfiles(ctx).list())
    for (const rule of profile.rules)
      targets.push({
        source: "profile",
        label: profile.name,
        cidr: rule.kind === "subnet" ? rule.cidr : `${rule.address}/32`,
      });
  for (const target of ctx.config.privateEgressTargets ?? [])
    targets.push({
      source: "private_target",
      label: target.hostname,
      cidr: `${target.address}/32`,
    });
  for (const cidr of ctx.config.lanCidrs ?? [])
    targets.push({ source: "lan_cidr", label: "NETWORK_LAN_CIDRS", cidr });
  return targets;
}

/** The provider's networks, or undefined when it cannot list them. */
export async function providerNetworks(
  ctx: GatewayContext,
): Promise<SandboxNetworkSubnet[] | undefined> {
  return ctx.provider.networkSubnets === undefined ? undefined : ctx.provider.networkSubnets();
}

export async function detectNetworkOverlaps(ctx: GatewayContext): Promise<NetworkOverlapReport> {
  const networks = await providerNetworks(ctx);
  if (networks === undefined) return { checked: false, networks: [], overlaps: [] };
  return { checked: true, networks, overlaps: findNetworkOverlaps(lanTargets(ctx), networks) };
}

/**
 * The Gateway's startup preflight: one warning per overlap. Never throws and never blocks
 * startup; a provider that cannot list its networks is reported once.
 */
export async function reportNetworkOverlaps(
  ctx: GatewayContext,
  warn: (message: string) => void,
): Promise<NetworkOverlap[]> {
  try {
    const report = await detectNetworkOverlaps(ctx);
    for (const overlap of report.overlaps) warn(overlapWarning(overlap));
    return report.overlaps;
  } catch (error) {
    warn(`Docker/LAN subnet overlap not checked: ${String(error)}`);
    return [];
  }
}

/** One log line per overlap, for the Gateway's startup preflight. */
export function overlapWarning(overlap: NetworkOverlap): string {
  return `LAN target ${overlap.cidr} (${overlap.source} ${overlap.label}) overlaps Docker network ${overlap.network} (${overlap.networkCidr}): the host routes it to that bridge, not the LAN`;
}
