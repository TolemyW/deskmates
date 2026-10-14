import { createHash } from "node:crypto";
import { isDeskmatesError } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_UNIX_SOCKET,
  endpointFromDockerContext,
  parseDockerHost,
  resolveDockerEndpoint,
} from "./docker-endpoint.js";

describe("parseDockerHost", () => {
  it("parses unix sockets, bare paths and tcp hosts", () => {
    expect(parseDockerHost("unix:///var/run/docker.sock")).toEqual({
      kind: "unix",
      socketPath: "/var/run/docker.sock",
    });
    expect(parseDockerHost("/Users/me/.colima/default/docker.sock")).toEqual({
      kind: "unix",
      socketPath: "/Users/me/.colima/default/docker.sock",
    });
    expect(parseDockerHost("tcp://10.0.0.5:2376")).toEqual({
      kind: "tcp",
      host: "10.0.0.5",
      port: 2376,
    });
    expect(parseDockerHost("tcp://dockerhost")).toEqual({
      kind: "tcp",
      host: "dockerhost",
      port: 2375,
    });
  });

  it("returns undefined for empty or unsupported schemes", () => {
    expect(parseDockerHost("")).toBeUndefined();
    expect(parseDockerHost("ssh://user@box")).toBeUndefined();
    expect(parseDockerHost("unix://")).toBeUndefined();
  });
});

describe("endpointFromDockerContext", () => {
  const home = "/home/tester";
  const metaDir = createHash("sha256").update("colima").digest("hex");
  const files: Record<string, string> = {
    [`${home}/.docker/config.json`]: JSON.stringify({ currentContext: "colima" }),
    [`${home}/.docker/contexts/meta/${metaDir}/meta.json`]: JSON.stringify({
      Name: "colima",
      Endpoints: { docker: { Host: "unix:///home/tester/.colima/default/docker.sock" } },
    }),
  };
  const fs = { readFile: (p: string) => files[p] };

  it("reads the current context's endpoint from ~/.docker without spawning the docker CLI", () => {
    expect(endpointFromDockerContext(home, fs)).toEqual({
      kind: "unix",
      socketPath: "/home/tester/.colima/default/docker.sock",
    });
  });

  it("returns undefined when no context is set or the default context is active", () => {
    expect(endpointFromDockerContext(home, { readFile: () => undefined })).toBeUndefined();
    expect(
      endpointFromDockerContext(home, {
        readFile: (p) => (p.endsWith("config.json") ? '{"currentContext":"default"}' : undefined),
      }),
    ).toBeUndefined();
  });
});

describe("resolveDockerEndpoint with a TLS daemon", () => {
  // A bare object, not process.env: the test must not depend on the machine it runs on.
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => ({ ...extra });

  it("refuses a tcp endpoint when DOCKER_TLS_VERIFY is set, naming TLS as the reason", () => {
    let err: unknown;
    try {
      resolveDockerEndpoint(env({ DOCKER_HOST: "tcp://10.0.0.5:2376", DOCKER_TLS_VERIFY: "1" }));
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.code).toBe("sandbox_unavailable");
    expect(isDeskmatesError(err) && err.details.reason).toBe("tls_unsupported");
    // The old behaviour was to connect in the clear and report the endpoint as unreachable.
    expect(isDeskmatesError(err) && err.message).toMatch(/TLS endpoint/);
    expect(isDeskmatesError(err) && err.message).not.toMatch(/unreachable/);
  });

  it("still accepts a plaintext tcp endpoint, and ignores the flag for a unix socket", () => {
    expect(resolveDockerEndpoint(env({ DOCKER_HOST: "tcp://10.0.0.5:2375" }))).toEqual({
      kind: "tcp",
      host: "10.0.0.5",
      port: 2375,
    });
    // There is no TLS on a socket path, so the flag is irrelevant there.
    expect(
      resolveDockerEndpoint(
        env({ DOCKER_HOST: "unix:///var/run/docker.sock", DOCKER_TLS_VERIFY: "1" }),
      ),
    ).toEqual({ kind: "unix", socketPath: DEFAULT_UNIX_SOCKET });
  });

  it("treats an empty DOCKER_TLS_VERIFY as unset, as the docker CLI does", () => {
    expect(
      resolveDockerEndpoint(env({ DOCKER_HOST: "tcp://box:2375", DOCKER_TLS_VERIFY: "" })),
    ).toEqual({ kind: "tcp", host: "box", port: 2375 });
  });
});
