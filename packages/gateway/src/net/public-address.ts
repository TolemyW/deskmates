// Whether a resolved IP address is on the public internet. The same table as the managed egress
// proxy (`images/egress/egress-policy.mjs`, ADR-0010 decision 2); `public-address.test.ts` holds
// the two to the same verdicts. The Gateway uses it for the calls it makes on a tenant's behalf
// to a URL that tenant chose (ADR-0022 INT-02), so a tenant cannot aim the Gateway at its own
// loopback listeners, the cloud metadata service or a private network.

import { isIP } from "node:net";

function ipv4Number(address: string): number | undefined {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return undefined;
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function inV4Range(value: number, base: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === ((ipv4Number(base) ?? 0) & mask);
}

const BLOCKED_V4: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

function ipv6Groups(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const side = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const expandV4 = (parts: string[]): string[] | undefined => {
    const last = parts.at(-1);
    if (last === undefined || !last.includes(".")) return parts;
    const value = ipv4Number(last);
    if (value === undefined) return undefined;
    return [...parts.slice(0, -1), (value >>> 16).toString(16), (value & 0xffff).toString(16)];
  };
  const left = expandV4(side(halves[0] ?? ""));
  const right = expandV4(side(halves[1] ?? ""));
  if (left === undefined || right === undefined) return undefined;
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...left, ...Array<string>(missing).fill("0"), ...right].map((part) =>
    Number.parseInt(part || "0", 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g <= 0xffff)
    ? groups
    : undefined;
}

export function isPublicAddress(address: string): boolean {
  let candidate = address.toLowerCase();
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  if (isIP(candidate) === 4) {
    const value = ipv4Number(candidate);
    if (value === undefined) return false;
    return !BLOCKED_V4.some(([base, prefix]) => inV4Range(value, base, prefix));
  }
  if (isIP(candidate) !== 6) return false;
  const g = ipv6Groups(candidate);
  if (g === undefined) return false;
  if (g.slice(0, 5).every((part) => part === 0) && g[5] === 0xffff) {
    const mapped = (((g[6] ?? 0) << 16) | (g[7] ?? 0)) >>> 0;
    return isPublicAddress(
      `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`,
    );
  }
  if (g.every((part) => part === 0) || (g.slice(0, 7).every((p) => p === 0) && g[7] === 1))
    return false;
  const first = g[0] ?? 0;
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  return (first & 0xfe00) !== 0xfc00 && (first & 0xffc0) !== 0xfe80 && (first & 0xff00) !== 0xff00;
}
