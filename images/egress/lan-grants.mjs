// LAN grants from root-selected network profiles (ADR-0027 amendment 1). Defense in depth for the
// policy document the provider sends over Docker stdin: the same rules as contracts
// `parseNetworkRules` and the same verdict as `networkGrantFor`, repeated because this image
// imports nothing from the monorepo.

import os from "node:os";

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RFC1918 = [
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
];

export function ipv4Value(address) {
  const parts = typeof address === "string" ? address.split(".") : [];
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((o) => o > 255)) return undefined;
  return octets.reduce((value, octet) => value * 256 + octet, 0) >>> 0;
}

function mask(prefix) {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function inRange(value, base, prefix) {
  return (value & mask(prefix)) >>> 0 === (base & mask(prefix)) >>> 0;
}

function rfc1918(value) {
  return RFC1918.some(([base, prefix]) => inRange(value, base, prefix));
}

function fail() {
  throw new Error("invalid network grant");
}

function grant(x) {
  if (!x || typeof x !== "object" || Array.isArray(x)) fail();
  const fields =
    x.kind === "host"
      ? ["kind", "hostname", "address", "schemes", "ports", "expiresAt"]
      : ["kind", "cidr", "schemes", "ports", "expiresAt"];
  if (Object.keys(x).some((k) => !fields.includes(k))) fail();
  if (
    !Array.isArray(x.schemes) ||
    x.schemes.length === 0 ||
    x.schemes.some((s) => s !== "http" && s !== "https") ||
    !Array.isArray(x.ports) ||
    x.ports.length === 0 ||
    x.ports.length > 16 ||
    x.ports.some((p) => !Number.isInteger(p) || p < 1 || p > 65535) ||
    (x.expiresAt !== undefined &&
      (typeof x.expiresAt !== "string" ||
        !ISO_UTC.test(x.expiresAt) ||
        !Number.isFinite(Date.parse(x.expiresAt))))
  )
    fail();
  if (x.kind === "host") {
    const address = ipv4Value(x.address);
    if (
      typeof x.hostname !== "string" ||
      x.hostname.length > 253 ||
      !HOSTNAME.test(x.hostname) ||
      x.hostname === "host.docker.internal" ||
      x.hostname.endsWith(".localhost") ||
      address === undefined ||
      !rfc1918(address)
    )
      fail();
    return { ...x };
  }
  if (x.kind === "subnet") {
    const match = typeof x.cidr === "string" ? /^([0-9.]+)\/([0-9]{1,2})$/.exec(x.cidr) : null;
    const base = match ? ipv4Value(match[1]) : undefined;
    const prefix = match ? Number(match[2]) : -1;
    if (
      base === undefined ||
      prefix < 8 ||
      prefix > 32 ||
      (base & mask(prefix)) >>> 0 !== base ||
      !RFC1918.some(([b, p]) => prefix >= p && inRange(base, b, p))
    )
      fail();
    return { ...x };
  }
  return fail();
}

export function parseGrants(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 1024) fail();
  return input.map(grant);
}

/**
 * The address and expiry a request to `scheme://host:port` is admitted to, or undefined. A host
 * rule pins its exact name; a subnet rule admits a canonical IPv4 literal inside it.
 */
export function grantFor(grants, scheme, host, port, now = Date.now()) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  const literal = ipv4Value(name);
  for (const g of grants) {
    if (g.expiresAt !== undefined && Date.parse(g.expiresAt) <= now) continue;
    if (!g.schemes.includes(scheme) || !g.ports.includes(port)) continue;
    if (g.kind === "host" && g.hostname === name) {
      return { address: g.address, family: 4, expiresAt: optionalTime(g.expiresAt) };
    }
    if (g.kind === "subnet" && literal !== undefined) {
      const [base, prefix] = g.cidr.split("/");
      if (inRange(literal, ipv4Value(base), Number(prefix)))
        return { address: name, family: 4, expiresAt: optionalTime(g.expiresAt) };
    }
  }
  return undefined;
}

function optionalTime(value) {
  return value === undefined ? undefined : Date.parse(value);
}

/**
 * Decision 11: a grant never reaches this proxy's own networks (the workspace network, the
 * outbound bridge and its gateway, which is the Docker host) or the reserved host target.
 */
export function isInfrastructureAddress(address, hostTarget, interfaces = os.networkInterfaces()) {
  const value = ipv4Value(address);
  if (value === undefined) return true;
  if (address === hostTarget) return true;
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" && entry.family !== 4) continue;
      const [base, prefix] = String(entry.cidr ?? "").split("/");
      const network = ipv4Value(base);
      if (network === undefined) continue;
      if (inRange(value, network, Number(prefix))) return true;
    }
  }
  return false;
}
