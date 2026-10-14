import { promises as dns } from "node:dns";
import net from "node:net";

export const RESERVED_HOST = "host.docker.internal";

/** Resolve infrastructure configuration once at proxy startup, never per request. */
export async function resolveHostTarget(target, fallbackIp, lookup = dns.lookup) {
  if (
    typeof target !== "string" ||
    target.length > 253 ||
    (net.isIP(target) === 0 && !/^[a-z0-9.-]+$/.test(target))
  ) {
    throw new Error("invalid host target");
  }
  if (net.isIP(fallbackIp) === 0) throw new Error("invalid host fallback address");
  if (net.isIP(target) !== 0) return target;
  try {
    const answer = await lookup(target, { all: true, verbatim: true });
    if (!Array.isArray(answer) || answer.length === 0 || net.isIP(answer[0].address) === 0) {
      throw new Error("host target has no numeric address");
    }
    // Every real provider of the reserved alias (Docker Desktop, Lima/Colima, host-gateway)
    // answers with a private or loopback address. Anything else came from a DNS interceptor
    // that answers every name (Mihomo fake-IP on Testbox), so use the bridge address instead.
    if (target === RESERVED_HOST && !isPrivateAddress(answer[0].address)) return fallbackIp;
    return answer[0].address;
  } catch (error) {
    if (target === RESERVED_HOST && error?.code === "ENOTFOUND") return fallbackIp;
    throw error;
  }
}

const PRIVATE_V4 = [
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function v4(address) {
  return address.split(".").reduce((n, part) => ((n << 8) | Number(part)) >>> 0, 0);
}

/** RFC 1918, loopback, link-local, CGNAT, IPv6 loopback, ULA and link-local. */
export function isPrivateAddress(address) {
  const a = address.toLowerCase().replace(/^::ffff:(?=\d+\.)/, "");
  if (net.isIP(a) === 4) {
    const value = v4(a);
    return PRIVATE_V4.some(([base, prefix]) => {
      const mask = (0xffffffff << (32 - prefix)) >>> 0;
      return (value & mask) === (v4(base) & mask);
    });
  }
  if (net.isIP(a) === 6) return a === "::1" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a);
  return false;
}

export function hostException(hostname) {
  return hostname === RESERVED_HOST;
}

export function hostPort(port, defaultPort) {
  const value = port === "" ? defaultPort : Number(port);
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error("invalid host port");
  return value;
}
