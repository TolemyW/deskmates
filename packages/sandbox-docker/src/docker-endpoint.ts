// Where the Docker Engine API lives. Resolution order:
//   1. DOCKER_HOST (unix:///path or tcp://host:port), the same variable the docker CLI honours.
//   2. The current docker CLI context: ~/.docker/config.json -> currentContext ->
//      ~/.docker/contexts/meta/<sha256(name)>/meta.json -> Endpoints.docker.Host.
//      This is how colima registers itself on macOS (socket at ~/.colima/default/docker.sock),
//      and it means the Gateway needs no `docker` binary on PATH.
//   3. /var/run/docker.sock, the Linux default.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeskmatesError } from "@deskmates/contracts";

export type DockerEndpoint =
  | { kind: "unix"; socketPath: string }
  | { kind: "tcp"; host: string; port: number };

export const DEFAULT_UNIX_SOCKET = "/var/run/docker.sock";

/** Parse a DOCKER_HOST-style URL. Returns undefined for values we cannot use (e.g. ssh://). */
export function parseDockerHost(value: string): DockerEndpoint | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  if (v.startsWith("unix://")) {
    const socketPath = v.slice("unix://".length);
    return socketPath === "" ? undefined : { kind: "unix", socketPath };
  }
  if (v.startsWith("tcp://") || v.startsWith("http://")) {
    try {
      const u = new URL(v.replace(/^tcp:/, "http:"));
      const port = u.port === "" ? 2375 : Number(u.port);
      if (!Number.isInteger(port) || u.hostname === "") return undefined;
      return { kind: "tcp", host: u.hostname, port };
    } catch {
      return undefined;
    }
  }
  // A bare absolute path is treated as a unix socket, as the docker CLI does.
  if (v.startsWith("/")) return { kind: "unix", socketPath: v };
  return undefined;
}

interface ContextLookupFs {
  readFile(path: string): string | undefined;
}

const realFs: ContextLookupFs = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

/** Host from the docker CLI's current context, if one is configured. */
export function endpointFromDockerContext(
  home: string = homedir(),
  fs: ContextLookupFs = realFs,
): DockerEndpoint | undefined {
  const config = fs.readFile(join(home, ".docker", "config.json"));
  if (config === undefined) return undefined;
  let currentContext: unknown;
  try {
    currentContext = (JSON.parse(config) as { currentContext?: unknown }).currentContext;
  } catch {
    return undefined;
  }
  if (typeof currentContext !== "string" || currentContext === "" || currentContext === "default") {
    return undefined;
  }
  const dir = createHash("sha256").update(currentContext).digest("hex");
  const meta = fs.readFile(join(home, ".docker", "contexts", "meta", dir, "meta.json"));
  if (meta === undefined) return undefined;
  try {
    const parsed = JSON.parse(meta) as { Endpoints?: { docker?: { Host?: unknown } } };
    const host = parsed.Endpoints?.docker?.Host;
    return typeof host === "string" ? parseDockerHost(host) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A `tcp://` endpoint is assumed to be plain HTTP: DockerClient talks `node:http` and has no place
 * to put a CA, a client certificate or a key. The docker CLI sets DOCKER_TLS_VERIFY when the daemon
 * speaks TLS, and connecting to it in the clear fails deep inside the socket with an `ECONNRESET`
 * that the client reports as "Docker daemon unreachable". Say what is actually wrong instead.
 */
export function assertPlaintextEndpoint(ep: DockerEndpoint, env: NodeJS.ProcessEnv): void {
  if (ep.kind !== "tcp") return;
  const verify = env.DOCKER_TLS_VERIFY;
  if (verify === undefined || verify === "") return;
  const fix =
    "@deskmates/sandbox-docker speaks plain HTTP only. Point DOCKER_HOST at a unix socket" +
    " (DOCKER_HOST=unix:///var/run/docker.sock) or forward the socket locally.";
  throw new DeskmatesError(
    "sandbox_unavailable",
    `DOCKER_TLS_VERIFY is set, so ${describeEndpoint(ep)} is a TLS endpoint; ${fix}`,
    { reason: "tls_unsupported", endpoint: describeEndpoint(ep) },
  );
}

export function resolveDockerEndpoint(env: NodeJS.ProcessEnv = process.env): DockerEndpoint {
  const fromEnv = env.DOCKER_HOST === undefined ? undefined : parseDockerHost(env.DOCKER_HOST);
  if (fromEnv) {
    assertPlaintextEndpoint(fromEnv, env);
    return fromEnv;
  }
  const fromContext = endpointFromDockerContext();
  if (fromContext && (fromContext.kind === "tcp" || existsSync(fromContext.socketPath))) {
    assertPlaintextEndpoint(fromContext, env);
    return fromContext;
  }
  return { kind: "unix", socketPath: DEFAULT_UNIX_SOCKET };
}

export function describeEndpoint(ep: DockerEndpoint): string {
  return ep.kind === "unix" ? `unix://${ep.socketPath}` : `tcp://${ep.host}:${ep.port}`;
}
