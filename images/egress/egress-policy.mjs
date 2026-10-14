import net from "node:net";
import { grantFor, isInfrastructureAddress, parseGrants } from "./lan-grants.mjs";

const HOST_PATTERN =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// The lone `*` allowlist entry: any public hostname (ADR-0010). It is valid only on its own.
const OPEN_INTERNET = "*";

export function normalizePatterns(input) {
  const patterns = [...new Set(input.map((value) => value.trim().toLowerCase()).filter(Boolean))];
  if (patterns.includes(OPEN_INTERNET)) {
    if (patterns.length > 1) throw new Error("egress pattern * must be the only entry");
    return patterns;
  }
  for (const pattern of patterns) {
    if (!HOST_PATTERN.test(pattern) || net.isIP(pattern.replace(/^\*\./, "")) !== 0) {
      throw new Error("invalid egress hostname pattern");
    }
  }
  return patterns.sort();
}

// Same meaning as contracts `isPublicHostname`: a well-formed name that is not an IP literal in
// any spelling (a numeric last label is IPv4 to URL parsers and curl), not loopback by name, and
// not the reserved host name, which has its own path (ADR-0009). Resolved addresses are checked
// separately by `isPublicAddress`, so this never has to be the only guard.
function publicHostname(host) {
  if (!HOST_PATTERN.test(host) || host.startsWith("*.")) return false;
  if (/^(0x[0-9a-f]*|[0-9]+)$/.test(host.slice(host.lastIndexOf(".") + 1))) return false;
  if (host === "localhost" || host.endsWith(".localhost")) return false;
  return host !== "host.docker.internal";
}

export function hostnameAllowed(hostname, patterns) {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (net.isIP(host.replace(/^\[|\]$/g, "")) !== 0) return false;
  return patterns.some((pattern) => {
    if (pattern === OPEN_INTERNET) return publicHostname(host);
    if (!pattern.startsWith("*.")) return host === pattern;
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  });
}

// Defense in depth for the deployment-owned policy received over Docker stdin (ADR-0027).
export function privateTargets(input) {
  if (!Array.isArray(input) || input.length > 64) throw new Error("invalid private targets");
  const seen = new Set();
  return input.map((x) => {
    const parts = typeof x?.address === "string" ? x.address.split(".") : [];
    const n = parts.map(Number);
    const privateV4 =
      parts.length === 4 &&
      parts.every((p, i) => /^(0|[1-9][0-9]{0,2})$/.test(p) && n[i] <= 255) &&
      (n[0] === 10 || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) || (n[0] === 192 && n[1] === 168));
    if (
      !x ||
      typeof x !== "object" ||
      Array.isArray(x) ||
      Object.keys(x).some(
        (k) => !["workspaceId", "hostname", "address", "port", "expiresAt"].includes(k),
      ) ||
      typeof x.workspaceId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(x.workspaceId) ||
      typeof x.hostname !== "string" ||
      x.hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        x.hostname,
      ) ||
      x.hostname === "host.docker.internal" ||
      x.hostname.endsWith(".localhost") ||
      !privateV4 ||
      x.port !== 443 ||
      typeof x.expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(x.expiresAt) ||
      !Number.isFinite(Date.parse(x.expiresAt)) ||
      seen.has(x.hostname)
    )
      throw new Error("invalid private target");
    seen.add(x.hostname);
    return { ...x };
  });
}

export function parsePolicyDocument(text) {
  if (!text.trim().startsWith("{"))
    return { allowlist: text.split("\n"), privateTargets: [], grants: [] };
  const doc = JSON.parse(text);
  // Version 2 adds network-profile grants (ADR-0027 amendment 1); version 1 never carries them.
  const fields = doc.version === 2 ? ["version", "allowlist", "privateTargets", "grants"] : [];
  if (doc.version === 1) fields.push("version", "allowlist", "privateTargets");
  if (fields.length === 0 || Object.keys(doc).some((k) => !fields.includes(k)))
    throw new Error("invalid policy version");
  return {
    allowlist: normalizePatterns(doc.allowlist),
    privateTargets: privateTargets(doc.privateTargets),
    grants: doc.version === 2 ? parseGrants(doc.grants) : [],
  };
}

export function createPolicyState(initialPatterns = []) {
  let patterns = normalizePatterns(initialPatterns);
  let generation = 0;
  let pinned = [];
  let grants = [];
  return {
    get size() {
      return patterns.length;
    },
    replace(nextPatterns, targets = [], nextGrants = []) {
      patterns = [];
      pinned = [];
      grants = [];
      generation += 1;
      const names = normalizePatterns(nextPatterns);
      const entries = privateTargets(targets);
      const lan = parseGrants(nextGrants);
      patterns = names;
      pinned = entries;
      grants = lan;
    },
    /**
     * The connect target a network-profile grant admits for `scheme://host:port`, else
     * undefined (ADR-0027 amendment 1 decision 10). Never consults the allowlist: `*` and
     * patterns admit no private target. A grant aimed at this proxy's own networks or the
     * reserved host target is refused outright (decision 11).
     */
    lanTarget(scheme, host, port, hostTarget, interfaces) {
      const answer = grantFor(grants, scheme, host.replace(/^\[|\]$/g, ""), port);
      if (answer === undefined) return undefined;
      if (isInfrastructureAddress(answer.address, hostTarget, interfaces))
        throw new Error("grant targets proxy infrastructure");
      return answer;
    },
    failClosed() {
      grants = [];
      pinned = [];
      patterns = [];
      generation += 1;
    },
    async resolvePublic(name, lookup, port = 443) {
      const authorizedGeneration = generation;
      const hostname = name.toLowerCase().replace(/\.$/, "");
      const target = pinned.find((entry) => entry.hostname === hostname);
      if (target) {
        if (
          !patterns.includes(hostname) ||
          port !== 443 ||
          Date.parse(target.expiresAt) <= Date.now()
        )
          throw new Error("private target denied");
        return { address: target.address, family: 4, expiresAt: Date.parse(target.expiresAt) };
      }
      if (!hostnameAllowed(hostname, patterns)) throw new Error("hostname denied");
      const answers = await lookup(hostname);
      // SIGHUP can run while DNS is pending. Authorization under an older generation is never
      // carried across the await, even when the hostname happens to remain allowed.
      if (generation !== authorizedGeneration || !hostnameAllowed(hostname, patterns)) {
        throw new Error("egress policy changed");
      }
      if (answers.length === 0 || answers.some((answer) => !isPublicAddress(answer.address))) {
        throw new Error("address denied");
      }
      return answers[0];
    },
  };
}

/**
 * Socket options for the upstream connection: always the numeric address `resolvePublic` checked,
 * never the requested name. Handing Node a hostname would resolve it a second time, and that
 * answer could rebind to a non-public address after the check.
 */
export function connectTarget(answer, port) {
  return { host: answer.address, family: answer.family, port };
}

function ipv4Number(address) {
  const parts = address.split(".").map(Number);
  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    return undefined;
  }
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inV4Range(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (base & mask);
}

function ipv6Groups(address) {
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const parseSide = (side) => (side === "" ? [] : side.split(":"));
  const left = parseSide(halves[0]);
  const right = parseSide(halves[1] ?? "");
  const expandV4 = (parts) => {
    const last = parts.at(-1);
    if (last === undefined || !last.includes(".")) return parts;
    const value = ipv4Number(last);
    if (value === undefined) return undefined;
    return [...parts.slice(0, -1), (value >>> 16).toString(16), (value & 0xffff).toString(16)];
  };
  const expandedLeft = expandV4(left);
  const expandedRight = expandV4(right);
  if (expandedLeft === undefined || expandedRight === undefined) return undefined;
  const missing = 8 - expandedLeft.length - expandedRight.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return undefined;
  const groups = [...expandedLeft, ...Array(missing).fill("0"), ...expandedRight].map((part) =>
    Number.parseInt(part || "0", 16),
  );
  return groups.length === 8 && groups.every((part) => Number.isInteger(part) && part <= 0xffff)
    ? groups
    : undefined;
}

export function isPublicAddress(address) {
  let candidate = address.toLowerCase();
  if (candidate.startsWith("::ffff:")) candidate = candidate.slice(7);
  if (net.isIP(candidate) === 4) {
    const value = ipv4Number(candidate);
    if (value === undefined) return false;
    const blocked = [
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
    return !blocked.some(([base, prefix]) => inV4Range(value, ipv4Number(base), prefix));
  }
  if (net.isIP(candidate) !== 6) return false;
  const groups = ipv6Groups(candidate);
  if (groups === undefined) return false;
  if (groups.slice(0, 5).every((part) => part === 0) && groups[5] === 0xffff) {
    const mapped = ((groups[6] << 16) | groups[7]) >>> 0;
    const dotted = `${mapped >>> 24}.${(mapped >>> 16) & 255}.${(mapped >>> 8) & 255}.${mapped & 255}`;
    return isPublicAddress(dotted);
  }
  if (
    groups.every((part) => part === 0) ||
    (groups.slice(0, 7).every((part) => part === 0) && groups[7] === 1)
  )
    return false;
  const first = groups[0];
  // fc00::/7 unique-local, fe80::/10 link-local, ff00::/8 multicast.
  return (first & 0xfe00) !== 0xfc00 && (first & 0xffc0) !== 0xfe80 && (first & 0xff00) !== 0xff00;
}
