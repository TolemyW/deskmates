// Operator-owned RFC1918 HTTPS grants (ADR-0027), never an agent-editable allowlist.
import { DeskmatesError } from "./errors.js";

export interface PrivateEgressTarget {
  workspaceId: string;
  hostname: string;
  address: string;
  port: 443;
  expiresAt: string;
}

export function parsePrivateEgressTargets(value: unknown): PrivateEgressTarget[] {
  if (!Array.isArray(value) || value.length > 64)
    throw new DeskmatesError(
      "validation",
      "private egress targets must be an array of at most 64 entries",
    );
  const seen = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new DeskmatesError("validation", "invalid private egress target");
    const x = item as Record<string, unknown>;
    const { workspaceId, hostname, address, port, expiresAt } = x;
    const parts = typeof address === "string" ? address.split(".") : [];
    const octets = parts.map(Number);
    const privateAddress =
      parts.length === 4 &&
      parts.every((p, i) => /^(0|[1-9][0-9]{0,2})$/.test(p) && (octets[i] ?? 256) <= 255) &&
      (octets[0] === 10 ||
        (octets[0] === 172 && (octets[1] ?? -1) >= 16 && (octets[1] ?? 32) <= 31) ||
        (octets[0] === 192 && octets[1] === 168));
    if (
      Object.keys(x).some(
        (k) => !["workspaceId", "hostname", "address", "port", "expiresAt"].includes(k),
      ) ||
      typeof workspaceId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,200}$/.test(workspaceId) ||
      typeof hostname !== "string" ||
      hostname.length > 253 ||
      !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
        hostname,
      ) ||
      hostname === "host.docker.internal" ||
      hostname.endsWith(".localhost") ||
      !privateAddress ||
      port !== 443 ||
      typeof expiresAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(expiresAt) ||
      !Number.isFinite(Date.parse(expiresAt))
    )
      throw new DeskmatesError(
        "validation",
        "invalid private egress target: exact workspace, DNS name, RFC1918 IPv4, port 443 and UTC expiration required",
      );
    const key = `${workspaceId}/${hostname}`;
    if (seen.has(key)) throw new DeskmatesError("validation", "duplicate private egress target");
    seen.add(key);
    return { workspaceId, hostname, address: address as string, port, expiresAt };
  });
}
