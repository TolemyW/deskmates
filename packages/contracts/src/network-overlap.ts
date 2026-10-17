// Docker/LAN subnet overlap (ADR-0027 amendment 2 decision 15). A LAN target inside the subnet of
// a Docker network on the same daemon is routed by the host into that bridge, not onto the LAN,
// and no grant changes that. Detection only: nothing here is refused or repaired.

import { ipv4Value } from "./network-profile.js";

/** One IPv4 subnet of a network the sandbox provider's daemon has, e.g. a Docker bridge. */
export interface SandboxNetworkSubnet {
  name: string;
  cidr: string;
}

/** Where a LAN target the Gateway knows comes from. */
export type LanTargetSource = "profile" | "private_target" | "lan_cidr";

export interface LanTarget {
  source: LanTargetSource;
  /** Human-readable origin: the profile name, the private target's hostname, the variable. */
  label: string;
  /** An IPv4 CIDR; a single address is `/32`. */
  cidr: string;
}

export interface NetworkOverlap extends LanTarget {
  network: string;
  networkCidr: string;
}

/** `a.b.c.d/n` or a bare address (as /32) to its network base and prefix; undefined if neither. */
export function parseIpv4Cidr(value: string): { base: number; prefix: number } | undefined {
  const [address, bits, extra] = value.trim().split("/");
  if (extra !== undefined || address === undefined) return undefined;
  const parsed = ipv4Value(address);
  const prefix = bits === undefined ? 32 : /^[0-9]{1,2}$/.test(bits) ? Number(bits) : -1;
  if (parsed === undefined || prefix < 0 || prefix > 32) return undefined;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return { base: (parsed & mask) >>> 0, prefix };
}

/** Whether two IPv4 CIDRs share any address; false when either does not parse. */
export function cidrsOverlap(a: string, b: string): boolean {
  const x = parseIpv4Cidr(a);
  const y = parseIpv4Cidr(b);
  if (x === undefined || y === undefined) return false;
  const prefix = Math.min(x.prefix, y.prefix);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (x.base & mask) >>> 0 === (y.base & mask) >>> 0;
}

/** Every (target, network) pair whose subnets overlap, in target then network order. */
export function findNetworkOverlaps(
  targets: readonly LanTarget[],
  networks: readonly SandboxNetworkSubnet[],
): NetworkOverlap[] {
  const overlaps: NetworkOverlap[] = [];
  for (const target of targets)
    for (const network of networks)
      if (cidrsOverlap(target.cidr, network.cidr))
        overlaps.push({ ...target, network: network.name, networkCidr: network.cidr });
  return overlaps;
}

/** The first provider network whose subnet holds this IPv4 address. */
export function networkHolding(
  address: string,
  networks: readonly SandboxNetworkSubnet[],
): SandboxNetworkSubnet | undefined {
  if (ipv4Value(address) === undefined) return undefined;
  return networks.find((network) => cidrsOverlap(`${address}/32`, network.cidr));
}
