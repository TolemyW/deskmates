// Operator network profiles (ADR-0027 amendment 1): named, durable sets of LAN grants the root
// selects per workspace. The parser is the one validator for routes and the provider; the
// matcher is the one tool-level verdict the sidecar hook uses. `images/egress/egress-policy.mjs`
// repeats both for the proxy, and the shared cases in each package's tests hold them together.

import { DeskmatesError } from "./errors.js";

export type NetworkScheme = "http" | "https";

interface NetworkRuleBase {
  /** Non-empty, sorted, deduplicated. */
  schemes: NetworkScheme[];
  /** 1 to 16 ports in 1..65535, sorted, deduplicated. */
  ports: number[];
}

/** An exact DNS name pinned to one RFC1918 IPv4 address; the proxy never resolves it. */
export interface NetworkHostRule extends NetworkRuleBase {
  kind: "host";
  hostname: string;
  address: string;
}

/** An RFC1918 IPv4 CIDR whose addresses may be used as IP-literal URL hosts. */
export interface NetworkSubnetRule extends NetworkRuleBase {
  kind: "subnet";
  cidr: string;
}

export type NetworkRule = NetworkHostRule | NetworkSubnetRule;

/** A rule as published to one workspace: the profile's rule with the effective expiry. */
export type NetworkGrant = NetworkRule & { expiresAt?: string };

export interface NetworkProfile {
  id: string;
  name: string;
  description: string;
  rules: NetworkRule[];
  /** Absent: persistent. */
  expiresAt?: string;
  /** Incremented by every replace; an editor may send it back as `expectedRevision`. */
  revision: number;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface WorkspaceNetworkSelection {
  profileId: string;
  profileName: string;
  /** The selection's own expiry; the grant expires at the earlier of this and the profile's. */
  expiresAt?: string;
  selectedAt: string;
  selectedBy: string;
}

/** What publishing a policy change did to one workspace's proxy (decision 7). */
export interface NetworkPublication {
  workspaceId: string;
  status: "applied" | "unchanged" | "not_running" | "failed";
  /** The acknowledged policy hash; absent when nothing was acknowledged. */
  policyHash?: string;
  error?: string;
}

/** `GET /api/workspaces/:id/network`: the trusted-test label and the selected profiles. */
export interface WorkspaceNetworkView {
  workspaceId: string;
  trustedTest: boolean;
  selections: WorkspaceNetworkSelection[];
  /** The unexpired grants the workspace's hook and proxy enforce now. */
  grants: NetworkGrant[];
}

export const NETWORK_PROFILE_MAX_RULES = 64;
export const NETWORK_RULE_MAX_PORTS = 16;

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const RFC1918: ReadonlyArray<readonly [number, number]> = [
  [0x0a000000, 8],
  [0xac100000, 12],
  [0xc0a80000, 16],
];

/** The 32-bit value of a canonical dotted-quad IPv4 address, else undefined. */
export function ipv4Value(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9][0-9]{0,2})$/.test(p))) return undefined;
  const octets = parts.map(Number);
  if (octets.some((o) => o > 255)) return undefined;
  return octets.reduce((value, octet) => value * 256 + octet, 0) >>> 0;
}

function maskOf(prefix: number): number {
  return prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
}

function inRange(value: number, base: number, prefix: number): boolean {
  const mask = maskOf(prefix);
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

/** Whether a canonical IPv4 address is inside 10/8, 172.16/12 or 192.168/16. */
export function isRfc1918(address: string): boolean {
  const value = ipv4Value(address);
  return value !== undefined && RFC1918.some(([base, prefix]) => inRange(value, base, prefix));
}

function fail(message: string): never {
  throw new DeskmatesError("validation", `invalid network rule: ${message}`);
}

function parseExpiry(value: unknown, what: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !ISO_UTC.test(value) || !Number.isFinite(Date.parse(value)))
    throw new DeskmatesError("validation", `${what} expiresAt must be an ISO UTC timestamp`);
  return value;
}

export function parseNetworkExpiry(value: unknown, what = "network"): string | undefined {
  return parseExpiry(value, what);
}

function parseRule(value: unknown): NetworkRule {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("not an object");
  const x = value as Record<string, unknown>;
  const allowed =
    x.kind === "host"
      ? ["kind", "hostname", "address", "schemes", "ports"]
      : ["kind", "cidr", "schemes", "ports"];
  if (Object.keys(x).some((k) => !allowed.includes(k))) fail("unknown field");
  if (
    !Array.isArray(x.schemes) ||
    x.schemes.length === 0 ||
    x.schemes.some((s) => s !== "http" && s !== "https")
  )
    fail("schemes must be a non-empty list of http and https");
  const schemes = [...new Set(x.schemes as NetworkScheme[])].sort();
  if (
    !Array.isArray(x.ports) ||
    x.ports.length === 0 ||
    x.ports.length > NETWORK_RULE_MAX_PORTS ||
    x.ports.some((p) => !Number.isInteger(p) || (p as number) < 1 || (p as number) > 65535)
  )
    fail(`ports must be 1 to ${NETWORK_RULE_MAX_PORTS} integers in 1..65535`);
  const ports = [...new Set(x.ports as number[])].sort((a, b) => a - b);
  if (x.kind === "host") {
    const { hostname, address } = x;
    if (
      typeof hostname !== "string" ||
      hostname.length > 253 ||
      !HOSTNAME.test(hostname) ||
      hostname === "host.docker.internal" ||
      hostname.endsWith(".localhost")
    )
      fail("hostname must be an exact lowercase DNS name");
    if (typeof address !== "string" || !isRfc1918(address))
      fail("address must be a canonical RFC1918 IPv4 address");
    return { kind: "host", hostname, address, schemes, ports };
  }
  if (x.kind === "subnet") {
    const match = typeof x.cidr === "string" ? /^([0-9.]+)\/([0-9]{1,2})$/.exec(x.cidr) : null;
    const base = match?.[1] === undefined ? undefined : ipv4Value(match[1]);
    const prefix = match ? Number(match[2]) : -1;
    if (
      base === undefined ||
      prefix < 8 ||
      prefix > 32 ||
      (base & maskOf(prefix)) >>> 0 !== base ||
      !RFC1918.some(([b, p]) => prefix >= p && inRange(base, b, p))
    )
      fail("cidr must be a canonical network inside one RFC1918 block");
    return { kind: "subnet", cidr: x.cidr as string, schemes, ports };
  }
  return fail("kind must be host or subnet");
}

/** Validates a whole rule list; any bad rule rejects the list (decision 7: before mutation). */
export function parseNetworkRules(value: unknown): NetworkRule[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > NETWORK_PROFILE_MAX_RULES)
    throw new DeskmatesError(
      "validation",
      `rules must be a list of 1 to ${NETWORK_PROFILE_MAX_RULES} network rules`,
    );
  const rules = value.map(parseRule);
  const hosts = rules.flatMap((r) => (r.kind === "host" ? [r.hostname] : []));
  if (new Set(hosts).size !== hosts.length)
    throw new DeskmatesError("validation", "a hostname may appear in one host rule only");
  return rules;
}

export function parseNetworkProfileName(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > 80)
    throw new DeskmatesError("validation", "profile name must be 1 to 80 characters");
  return value.trim();
}

/** The earlier of two optional expiries. */
export function earlierExpiry(a?: string, b?: string): string | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** The parts of a URL a grant matches on, or undefined for anything that is not http(s). */
export function networkTarget(
  url: string,
): { scheme: NetworkScheme; host: string; port: number } | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  const scheme = parsed.protocol === "http:" ? "http" : "https";
  const port = parsed.port === "" ? (scheme === "http" ? 80 : 443) : Number(parsed.port);
  return { scheme, host: parsed.hostname.toLowerCase().replace(/\.$/, ""), port };
}

/**
 * The grant that admits `scheme://host:port` now, or undefined (decision 10). A host rule
 * matches its exact name; a subnet rule matches a canonical IPv4 literal inside it. An allowlist
 * pattern, `*` included, is never consulted here: only grants admit a private target.
 */
export function networkGrantFor(
  grants: readonly NetworkGrant[],
  target: { scheme: string; host: string; port: number },
  now = Date.now(),
): NetworkGrant | undefined {
  const host = target.host.toLowerCase().replace(/\.$/, "");
  const literal = ipv4Value(host);
  return grants.find((grant) => {
    if (grant.expiresAt !== undefined && Date.parse(grant.expiresAt) <= now) return false;
    if (!grant.schemes.includes(target.scheme as NetworkScheme)) return false;
    if (!grant.ports.includes(target.port)) return false;
    if (grant.kind === "host") return grant.hostname === host;
    if (literal === undefined) return false;
    const [base, prefix] = grant.cidr.split("/");
    const network = ipv4Value(base ?? "");
    return network !== undefined && inRange(literal, network, Number(prefix));
  });
}

/** Whether a URL is admitted by a grant now. */
export function networkGrantAllowsUrl(
  grants: readonly NetworkGrant[],
  url: string,
  now = Date.now(),
): boolean {
  const target = networkTarget(url);
  return target !== undefined && networkGrantFor(grants, target, now) !== undefined;
}

/** The layers a connectivity preflight tells apart (ADR-0027 amendment 1 decision 14). */
/** `route`: the target lies inside a Docker network of the daemon (amendment 2 decision 15). */
export type NetworkLayer = "policy" | "route" | "dns" | "tcp" | "tls" | "http";

export interface NetworkLayerResult {
  layer: NetworkLayer;
  ok: boolean;
  detail?: string;
}

/** What the provider probes from the workspace's proxy: `address` pins a host rule. */
export interface EgressProbeRequest {
  url: string;
  address?: string;
  /** Admitted through a network-profile grant (else the public-address rule applies). */
  grant: boolean;
}

export interface EgressProbeResult {
  ok: boolean;
  layers: NetworkLayerResult[];
  /** The HTTP status when the HTTP layer answered. */
  status?: number;
}

/** `POST /api/workspaces/:id/network-preflight`. */
export interface NetworkPreflightResult extends EgressProbeResult {
  url: string;
  admittedBy?: "grant" | "allowlist";
  /** The first layer that failed; absent when every checked layer passed. */
  failedLayer?: NetworkLayer;
}
