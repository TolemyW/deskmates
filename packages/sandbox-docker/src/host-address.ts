// How a process inside a workspace container reaches the Gateway on the host.
//
// The workspace network is internal (ADR-0009). The reserved host name is sent to the managed
// egress proxy, which pins an operator-controlled host address on its outbound network. A
// deployment that fronts the Gateway differently can still pass an explicit reachable host.

import { DOCKER_HOST_ALIAS } from "@deskmates/contracts";

export const DEFAULT_CONTAINER_HOST_ALIAS = DOCKER_HOST_ALIAS;

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0", "[::]", "::"]);

/** Host name a container should use to reach the Gateway. */
export function gatewayHostForContainer(override?: string): string {
  const o = override?.trim();
  return o === undefined || o === "" ? DEFAULT_CONTAINER_HOST_ALIAS : o;
}

/**
 * Rewrite a Gateway URL as seen from the host (typically http://127.0.0.1:8080) into one a
 * container can dial. Only loopback and wildcard hosts are rewritten; anything else is assumed
 * to be reachable as-is.
 */
export function gatewayUrlForContainer(hostUrl: string, override?: string): string {
  const u = new URL(hostUrl);
  if (LOOPBACK.has(u.hostname) || LOOPBACK.has(`[${u.hostname}]`)) {
    u.hostname = gatewayHostForContainer(override);
  }
  return u.toString().replace(/\/$/, hostUrl.endsWith("/") ? "/" : "");
}
