// T0: DockerProvider logic that does not need a daemon. The Engine API is replaced by a scripted
// stub, so container selection, the readiness wait and the exec stream's failure modes are tested
// deterministically; the behaviour against a real daemon is in docker-provider.container.test.ts.

import type { Socket } from "node:net";
import { Duplex, PassThrough } from "node:stream";
import {
  NOVNC_CONTAINER_PORT,
  type SandboxHandle,
  type WorkspaceId,
  isDeskmatesError,
} from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { DockerClient } from "./docker-client.js";
import {
  APP_RELAY_KEY_ENV,
  DockerProvider,
  EGRESS_OUTBOUND_NETWORK,
  EGRESS_PROXY_ROLE,
  MANAGED_LABEL,
  ROLE_LABEL,
  TENANT_LABEL,
  VNC_PASSWORD_ENV,
  WORKSPACE_LABEL,
  networkName,
} from "./docker-provider.js";
import { encodeDockerFrame } from "./docker-stream.js";
import { createSandboxProvider } from "./index.js";

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

interface Stub {
  onStdin?: (chunk: string) => void;
  proxyPorts?: Record<string, { HostIp: string; HostPort: string }[]>;
  proxyHostTarget?: string;
  /** Extra variables in the proxy container's environment. */
  proxyEnv?: string[];
  /**
   * Start the managed proxy stopped, the way a real daemon reports one: no network address and
   * no published ports until it is started. `POST /containers/proxy1/start` flips it.
   */
  proxyStopped?: boolean;
  /** Answer for `client.expect`; the returned value becomes `json`. */
  expect?: (method: string, path: string) => unknown;
  /** Answer for `client.request`; defaults to 204 with an empty body. */
  request?: (method: string, path: string) => { status: number; body: string };
  /** Answer for `client.hijack`. */
  hijack?: () => { socket: Socket; head: Buffer };
}

/** Replace the three Engine API methods the provider uses. Returns the call log. */
function stubClient(client: DockerClient, stub: Stub): Call[] {
  const calls: Call[] = [];
  const networks = new Map<string, unknown>();
  let proxyWorkspace = "ws1";
  let proxyRunning = stub.proxyStopped !== true;
  const patch = {
    expect: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (
        path.startsWith("/containers/json") &&
        decodeURIComponent(path).includes("deskmates.role=workspace")
      ) {
        return { status: 200, json: [] };
      }
      if (
        path.startsWith("/containers/json") &&
        decodeURIComponent(path).includes(EGRESS_PROXY_ROLE)
      ) {
        return {
          status: 200,
          json: [
            summary("proxy1", proxyRunning ? "running" : "exited", {
              [WORKSPACE_LABEL]: proxyWorkspace,
              [MANAGED_LABEL]: "true",
              [ROLE_LABEL]: EGRESS_PROXY_ROLE,
            }),
          ],
        };
      }
      if (path === "/containers/proxy1/json") {
        return {
          status: 200,
          json: {
            ...inspectOf("proxy1", { running: proxyRunning }),
            Config: {
              Env: [
                `DESKMATES_HOST_TARGET=${stub.proxyHostTarget ?? "host.docker.internal"}`,
                "DESKMATES_HOST_FALLBACK_IP=172.31.0.1",
                ...(stub.proxyEnv ?? []),
              ],
              Labels: managedLabels(proxyWorkspace),
            },
            // A stopped container has no address and no published port until Docker starts it.
            NetworkSettings: {
              Ports: proxyRunning ? (stub.proxyPorts ?? {}) : {},
              Networks: {
                [networkName(proxyWorkspace as WorkspaceId)]: {
                  IPAddress: proxyRunning ? "172.31.0.2" : "",
                },
                [EGRESS_OUTBOUND_NETWORK]: { IPAddress: proxyRunning ? "172.32.0.2" : "" },
              },
            },
          },
        };
      }
      if (path === "/containers/proxy1/exec") return { status: 200, json: { Id: "proxy-exec" } };
      if (path === "/exec/proxy-exec/json") {
        return { status: 200, json: { Running: false, ExitCode: 0 } };
      }
      if (!stub.expect) throw new Error(`unstubbed expect ${method} ${path}`);
      return { status: 200, json: stub.expect(method, path) };
    },
    request: async (method: string, path: string, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === "GET" && path.startsWith("/networks/")) {
        const name = decodeURIComponent(path.slice("/networks/".length));
        const network = networks.get(name);
        return network === undefined
          ? { status: 404, body: "" }
          : { status: 200, body: JSON.stringify(network) };
      }
      if (method === "POST" && path === "/networks/create") {
        const config = body as {
          Name: string;
          Internal: boolean;
          Labels: Record<string, string>;
        };
        networks.set(config.Name, {
          Id: config.Name,
          Name: config.Name,
          Internal: config.Internal,
          Labels: config.Labels,
          // Like a real daemon: the IPAM block carries the bridge address. An internal network
          // gives its endpoints no default gateway, so this is the only place it appears.
          IPAM: { Config: [{ Subnet: "172.31.0.0/16", Gateway: "172.31.0.1" }] },
        });
        return { status: 201, body: JSON.stringify({ Id: config.Name }) };
      }
      if (method === "POST" && path === "/containers/proxy1/start") {
        proxyRunning = true;
        return { status: 204, body: "" };
      }
      if (method === "POST" && path.startsWith("/containers/create?name=deskmates-egress-")) {
        proxyWorkspace =
          (body as { Labels: Record<string, string> }).Labels[WORKSPACE_LABEL] ?? "ws1";
        return { status: 201, body: JSON.stringify({ Id: "proxy1" }) };
      }
      if (method === "DELETE" && path.startsWith("/networks/")) {
        networks.delete(decodeURIComponent(path.slice("/networks/".length)));
        return { status: 204, body: "" };
      }
      if (method === "POST" && path.startsWith("/networks/") && path.endsWith("/connect")) {
        return { status: 200, body: "" };
      }
      return stub.request?.(method, path) ?? { status: 204, body: "" };
    },
    hijack: async (path: string) => {
      calls.push({ method: "HIJACK", path });
      if (path === "/exec/proxy-exec/start") {
        const socket = new Duplex({
          read() {},
          write(_chunk, _encoding, callback) {
            stub.onStdin?.(String(_chunk));
            callback();
          },
        });
        setImmediate(() => socket.push(null));
        return { socket: socket as unknown as Socket, head: Buffer.alloc(0) };
      }
      if (!stub.hijack) throw new Error(`unstubbed hijack ${path}`);
      return stub.hijack();
    },
  };
  // The stub is shape-compatible with what the provider calls; DockerClient.expect is generic,
  // which a plain function literal cannot satisfy, hence the cast.
  Object.assign(client, patch as unknown as Partial<DockerClient>);
  return calls;
}

function newProvider(opts: { readyTimeoutMs?: number } = {}): DockerProvider {
  return new DockerProvider({
    endpoint: { kind: "unix", socketPath: "/nonexistent/docker.sock" },
    ...(opts.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: opts.readyTimeoutMs }),
  });
}

function summary(id: string, state: string, labels: Record<string, string>) {
  return { Id: id, State: state, Labels: labels };
}

function managedLabels(workspaceId: string): Record<string, string> {
  return {
    [WORKSPACE_LABEL]: workspaceId,
    [MANAGED_LABEL]: "true",
    [ROLE_LABEL]: "workspace",
  };
}

function inspectOf(id: string, o: { running?: boolean; health?: string } = {}) {
  return {
    Id: id,
    Name: `/${id}`,
    State: {
      Running: o.running ?? true,
      Status: (o.running ?? true) ? "running" : "exited",
      ...(o.health === undefined ? {} : { Health: { Status: o.health } }),
    },
    Config: { Env: [], Labels: managedLabels("ws1") },
    HostConfig: {
      NetworkMode: networkName("ws1" as WorkspaceId),
      ExtraHosts: ["egress-proxy:172.31.0.2"],
    },
    NetworkSettings: {
      Ports: {},
      Networks: { [networkName("ws1" as WorkspaceId)]: { IPAddress: "172.31.0.3" } },
    },
  };
}

const WS = "ws1" as WorkspaceId;
const LIST_PREFIX = "/containers/json";

function filtersOf(calls: Call[]): { label?: string[] } {
  const list = calls.find((c) => c.path.startsWith(LIST_PREFIX));
  const raw = new URLSearchParams(list?.path.split("?")[1] ?? "").get("filters") ?? "{}";
  return JSON.parse(raw) as { label?: string[] };
}

describe("DockerProvider.attach: which container it picks (L6)", () => {
  it("prefers a running container over a stale stopped one with the same label", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: (_m, path) => {
        if (path.startsWith(LIST_PREFIX)) {
          return [
            summary("stale", "exited", managedLabels("ws1")),
            summary("live", "running", managedLabels("ws1")),
          ];
        }
        if (path === "/containers/live/json") return inspectOf("live");
        throw new Error(`unexpected ${path}`);
      },
    });
    const handle = await p.attach(WS);
    expect(handle?.providerRef).toBe("live");
    // The stopped one is never inspected, let alone started.
    expect(calls.some((c) => c.path.includes("stale"))).toBe(false);
    expect(calls.some((c) => c.path.endsWith("/start"))).toBe(false);
  });

  it("asks the daemon for both labels and ignores a container that is not ours", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: (_m, path) => {
        // A daemon that ignores the filter (or a hand-made container carrying only the
        // workspace label) must not be adopted as the workspace.
        if (path.startsWith(LIST_PREFIX)) {
          return [summary("foreign", "running", { [WORKSPACE_LABEL]: "ws1" })];
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    expect(await p.attach(WS)).toBeUndefined();
    expect(filtersOf(calls).label).toEqual([`${WORKSPACE_LABEL}=ws1`, `${MANAGED_LABEL}=true`]);
  });

  it("starts the container when the only match is stopped", async () => {
    const p = newProvider();
    let running = false;
    const calls = stubClient(p.client, {
      expect: (_m, path) => {
        if (path.startsWith(LIST_PREFIX)) return [summary("c1", "exited", managedLabels("ws1"))];
        if (path === "/containers/c1/json") return inspectOf("c1", { running });
        throw new Error(`unexpected ${path}`);
      },
      request: (_m, path) => {
        if (path === "/containers/c1/start") running = true;
        return { status: 204, body: "" };
      },
    });
    expect((await p.attach(WS))?.providerRef).toBe("c1");
    expect(calls.some((c) => c.method === "POST" && c.path === "/containers/c1/start")).toBe(true);
  });
});

describe("DockerProvider permanent deletion (ADR-0026)", () => {
  it("removes only exact labelled resources and volumes, never a prefix-similar peer", async () => {
    const p = newProvider();
    const tenant = "tnt_one";
    const labels = {
      [WORKSPACE_LABEL]: WS,
      [MANAGED_LABEL]: "true",
      [TENANT_LABEL]: tenant,
    };
    const calls = stubClient(p.client, {
      expect: (_method, path) => {
        if (path.startsWith(LIST_PREFIX)) {
          return [
            summary("workspace", "exited", { ...labels, [ROLE_LABEL]: "workspace" }),
            summary("proxy", "exited", { ...labels, [ROLE_LABEL]: EGRESS_PROXY_ROLE }),
            summary("peer", "running", {
              [WORKSPACE_LABEL]: "ws10",
              [MANAGED_LABEL]: "true",
              [TENANT_LABEL]: tenant,
              [ROLE_LABEL]: "workspace",
            }),
          ];
        }
        throw new Error(`unexpected expect ${path}`);
      },
      request: (method, path) => {
        if (method === "GET" && path.startsWith("/volumes/deskmates-ws1-")) {
          return { status: 200, body: JSON.stringify({ Labels: labels }) };
        }
        return { status: 204, body: "" };
      },
    });
    await p.client.request("POST", "/networks/create", {
      Name: networkName(WS),
      Internal: true,
      Labels: labels,
    });
    calls.length = 0;

    await p.permanentlyDelete(WS, tenant);

    const removed = calls.filter((call) => call.method === "DELETE").map((call) => call.path);
    expect(removed).toEqual([
      "/containers/workspace?v=false&force=true",
      "/containers/proxy?v=false&force=true",
      `/networks/${networkName(WS)}`,
      "/volumes/deskmates-ws1-profile?force=true",
      "/volumes/deskmates-ws1-work?force=true",
      "/volumes/deskmates-ws1-home?force=true",
    ]);
    expect(removed.some((path) => path.includes("peer") || path.includes("ws10"))).toBe(false);
  });
});

describe("DockerProvider.attach: an unhealthy container is recovered (M1)", () => {
  it("restarts a running container whose health check says unhealthy", async () => {
    const p = newProvider();
    let health = "unhealthy";
    const calls = stubClient(p.client, {
      expect: (_m, path) => {
        if (path.startsWith(LIST_PREFIX)) return [summary("c1", "running", managedLabels("ws1"))];
        if (path === "/containers/c1/json") return inspectOf("c1", { health });
        throw new Error(`unexpected ${path}`);
      },
      request: (_m, path) => {
        if (path.startsWith("/containers/c1/restart")) health = "healthy";
        return { status: 204, body: "" };
      },
    });
    expect((await p.attach(WS))?.providerRef).toBe("c1");
    expect(calls.filter((c) => c.path.startsWith("/containers/c1/restart"))).toHaveLength(1);
  });

  it("leaves a healthy container alone", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: (_m, path) => {
        if (path.startsWith(LIST_PREFIX)) return [summary("c1", "running", managedLabels("ws1"))];
        if (path === "/containers/c1/json") return inspectOf("c1", { health: "healthy" });
        throw new Error(`unexpected ${path}`);
      },
    });
    await p.attach(WS);
    expect(calls.some((c) => c.path.includes("restart") || c.path.endsWith("/start"))).toBe(false);
  });
});

describe("DockerProvider readiness wait (M2)", () => {
  const spec = {
    workspaceId: WS,
    image: "img",
    env: {},
    volumes: {},
    ports: [],
    egressAllowlist: [],
  };

  function stubCreate(p: DockerProvider, health: () => string | undefined): Call[] {
    return stubClient(p.client, {
      expect: (_m, path) => {
        if (path === "/containers/c1/json") {
          const h = health();
          return h === undefined ? inspectOf("c1") : inspectOf("c1", { health: h });
        }
        throw new Error(`unexpected ${path}`);
      },
      request: (_m, path) => {
        if (path.startsWith("/containers/create")) {
          return { status: 201, body: JSON.stringify({ Id: "c1" }) };
        }
        return { status: 204, body: "" };
      },
    });
  }

  it("create does not return until the health check reports healthy", async () => {
    const p = newProvider({ readyTimeoutMs: 10_000 });
    const statuses = ["starting", "healthy"];
    let seen = 0;
    stubCreate(p, () => {
      const s = statuses[Math.min(seen, statuses.length - 1)] as string;
      seen += 1;
      return s;
    });
    const handle = await p.create(spec);
    expect(handle.providerRef).toBe("c1");
    // One inspect that saw "starting", one that saw "healthy", one for the handle.
    expect(seen).toBeGreaterThanOrEqual(3);
  }, 15_000);

  it("create gives the container its memory and CPU ceilings, and none when unset (ADR-0022 amd. 5)", async () => {
    const hostConfigOf = async (extra: { memoryLimitBytes?: number; cpuLimit?: number }) => {
      const p = newProvider();
      const calls = stubCreate(p, () => "healthy");
      await p.create({ ...spec, ...extra });
      const create = calls.find((c) => c.path.startsWith("/containers/create?name=deskmates-ws-"));
      return (create?.body as { HostConfig: Record<string, unknown> }).HostConfig;
    };
    const limited = await hostConfigOf({ memoryLimitBytes: 8 * 1024 ** 3, cpuLimit: 1.5 });
    expect(limited.Memory).toBe(8 * 1024 ** 3);
    expect(limited.NanoCpus).toBe(1_500_000_000);
    const unlimited = await hostConfigOf({});
    expect(unlimited).not.toHaveProperty("Memory");
    expect(unlimited).not.toHaveProperty("NanoCpus");
  });

  it("create fails with reason not_ready when the container never becomes healthy", async () => {
    const p = newProvider({ readyTimeoutMs: 0 });
    stubCreate(p, () => "starting");
    let err: unknown;
    try {
      await p.create(spec);
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.code).toBe("sandbox_unavailable");
    expect(isDeskmatesError(err) && err.details.reason).toBe("not_ready");
    expect(isDeskmatesError(err) && err.details.health).toBe("starting");
  });

  it("an image with no HEALTHCHECK (the alpine fixture) is not waited for", async () => {
    const p = newProvider({ readyTimeoutMs: 60_000 });
    let inspects = 0;
    stubCreate(p, () => {
      inspects += 1;
      return undefined;
    });
    const started = Date.now();
    await p.create(spec);
    expect(Date.now() - started).toBeLessThan(1000);
    // Exactly one readiness inspect plus the one handleFor makes.
    expect(inspects).toBe(2);
  });
});

describe("DockerProvider.create: published ports (design v0.3 §3.3)", () => {
  it("publishes no workspace ports and reads noVNC from the proxy", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      proxyPorts: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "49153" }] },
      expect: (_m, path) => {
        if (path === "/containers/c1/json") {
          return {
            ...inspectOf("c1"),
            NetworkSettings: {
              Ports: {},
              Networks: { [networkName(WS)]: { IPAddress: "172.31.0.3" } },
            },
            Config: { Env: [`${VNC_PASSWORD_ENV}=deadbeef`], Labels: managedLabels("ws1") },
          };
        }
        throw new Error(`unexpected ${path}`);
      },
      request: (_m, path) =>
        path.startsWith("/containers/create")
          ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
          : { status: 204, body: "" },
    });

    const handle = await p.create({
      workspaceId: WS,
      image: "img",
      env: { [VNC_PASSWORD_ENV]: "deadbeef" },
      volumes: {},
      ports: [NOVNC_CONTAINER_PORT],
      egressAllowlist: [],
    });

    const create = calls.find((c) => c.path.startsWith("/containers/create?name=deskmates-ws-"));
    const body = create?.body as {
      ExposedPorts: Record<string, unknown>;
      HostConfig: { PortBindings: Record<string, { HostIp: string; HostPort: string }[]> };
    };
    expect(Object.keys(body.ExposedPorts)).toEqual([]);
    // Loopback, not 0.0.0.0: the takeover screen is for the Gateway on this host, and an
    // unauthenticated VNC page must not be offered to the network (ADR-0006, deferred).
    expect(body.HostConfig.PortBindings).toEqual({});
    const proxyCreate = calls.find((c) =>
      c.path.startsWith("/containers/create?name=deskmates-egress-"),
    )?.body as { HostConfig: { PortBindings: Record<string, unknown> } };
    expect(proxyCreate.HostConfig.PortBindings["6080/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "" },
    ]);
    expect(handle.novncAddress).toBe("127.0.0.1:49153");
    expect(handle.novncPassword).toBe("deadbeef");
  });

  it("publishes nothing when the spec lists no ports", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: (_m, path) => {
        if (path === "/containers/c1/json") return inspectOf("c1");
        throw new Error(`unexpected ${path}`);
      },
      request: (_m, path) =>
        path.startsWith("/containers/create")
          ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
          : { status: 204, body: "" },
    });
    const handle = await p.create({
      workspaceId: WS,
      image: "img",
      env: {},
      volumes: {},
      ports: [],
      egressAllowlist: [],
    });
    const create = calls.find((c) => c.path.startsWith("/containers/create?name=deskmates-ws-"));
    const body = create?.body as { HostConfig: { PortBindings: Record<string, unknown> } };
    expect(body.HostConfig.PortBindings).toEqual({});
    expect(handle.novncAddress).toBeUndefined();
  });
});

describe("DockerProvider workspace isolation (ADR-0006)", () => {
  it("puts the workspace on one internal network behind a dual-homed managed proxy", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: (_method, path) => {
        if (path === "/containers/c1/json") return inspectOf("c1");
        throw new Error(`unexpected ${path}`);
      },
      request: (_method, path) =>
        path.startsWith("/containers/create?name=deskmates-ws-")
          ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
          : { status: 204, body: "" },
    });
    await p.create({
      workspaceId: WS,
      image: "workspace",
      env: {},
      volumes: {},
      ports: [],
      egressAllowlist: ["*.example.com"],
    });

    const workspaceCreate = calls.find((call) =>
      call.path.startsWith("/containers/create?name=deskmates-ws-"),
    )?.body as {
      Env: string[];
      HostConfig: { Dns: string[]; NetworkMode: string; CapDrop: string[]; ExtraHosts: string[] };
      NetworkingConfig: { EndpointsConfig: Record<string, unknown> };
    };
    expect(workspaceCreate.HostConfig.NetworkMode).toBe(networkName(WS));
    expect(workspaceCreate.HostConfig.Dns).toEqual(["127.0.0.1"]);
    expect(Object.keys(workspaceCreate.NetworkingConfig.EndpointsConfig)).toEqual([
      networkName(WS),
    ]);
    expect(workspaceCreate.HostConfig.ExtraHosts).toContain("egress-proxy:172.31.0.2");
    // The reserved host name is resolved only by the dual-homed proxy, never inside a workspace.
    expect(
      workspaceCreate.HostConfig.ExtraHosts.some((host) =>
        host.startsWith("host.docker.internal:"),
      ),
    ).toBe(false);
    expect(workspaceCreate.Env).toContain("HTTPS_PROXY=http://egress-proxy:3128");
    expect(workspaceCreate.Env).toContain("NO_PROXY=localhost,127.0.0.1,[::1],::1");

    const proxyCreate = calls.find((call) =>
      call.path.startsWith("/containers/create?name=deskmates-egress-"),
    )?.body as {
      Env: string[];
      HostConfig: { NetworkMode: string; CapDrop: string[]; ReadonlyRootfs: boolean };
      NetworkingConfig: { EndpointsConfig: Record<string, unknown> };
    };
    // Docker API v1.41 refuses a create with two endpoints; the outbound network is connected
    // after create and before start.
    expect(Object.keys(proxyCreate.NetworkingConfig.EndpointsConfig)).toEqual([networkName(WS)]);
    const proxyCreateIndex = calls.findIndex((c) => c.body === proxyCreate);
    const outboundConnectIndex = calls.findIndex(
      (c) =>
        c.path === `/networks/${EGRESS_OUTBOUND_NETWORK}/connect` &&
        (c.body as { Container?: string }).Container === "proxy1",
    );
    const proxyStartIndex = calls.findIndex((c) => c.path === "/containers/proxy1/start");
    expect(outboundConnectIndex).toBeGreaterThan(proxyCreateIndex);
    expect(proxyStartIndex).toBeGreaterThan(outboundConnectIndex);
    expect(proxyCreate.HostConfig).toMatchObject({
      NetworkMode: networkName(WS),
      CapDrop: ["ALL"],
      ReadonlyRootfs: true,
    });
    // A container/daemon restart must never resurrect the creation-time policy. Startup is
    // deny-all and create reloads the requested policy before it starts the workspace.
    // The app relay key is infrastructure, not policy (ADR-0035 decision 4).
    expect(proxyCreate.Env).toEqual([
      "DESKMATES_SCREEN_TARGET=deskmates-ws-ws1",
      expect.stringMatching(/^DESKMATES_APP_RELAY_KEY=[0-9a-f]{32}$/),
      "DESKMATES_HOST_TARGET=host.docker.internal",
      "DESKMATES_HOST_FALLBACK_IP=172.31.0.1",
    ]);
    const proxyPolicyWrite = calls.find(
      (call) =>
        call.path === "/containers/proxy1/exec" &&
        (call.body as { AttachStdin?: boolean }).AttachStdin === true,
    );
    const workspaceCreateCall = calls.findIndex((call) =>
      call.path.startsWith("/containers/create?name=deskmates-ws-"),
    );
    expect(proxyPolicyWrite).toBeDefined();
    expect(calls.indexOf(proxyPolicyWrite as Call)).toBeLessThan(workspaceCreateCall);

    const workspaceNetwork = calls.find(
      (call) =>
        call.path === "/networks/create" &&
        (call.body as { Name?: string }).Name === networkName(WS),
    )?.body;
    expect(workspaceNetwork).toMatchObject({
      Name: networkName(WS),
      Internal: true,
      Labels: { [MANAGED_LABEL]: "true", [WORKSPACE_LABEL]: WS },
    });
  });

  it("gives only the egress proxy the configured DNS servers (EGRESS_PROXY_DNS, ADR-0010)", async () => {
    const createBodies = async (p: DockerProvider) => {
      const calls = stubClient(p.client, {
        expect: (_method, path) => {
          if (path === "/containers/c1/json") return inspectOf("c1");
          throw new Error(`unexpected ${path}`);
        },
        request: (_method, path) =>
          path.startsWith("/containers/create?name=deskmates-ws-")
            ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
            : { status: 204, body: "" },
      });
      await p.create({
        workspaceId: WS,
        image: "workspace",
        env: {},
        volumes: {},
        ports: [],
        egressAllowlist: ["*"],
      });
      const body = (prefix: string) =>
        calls.find((call) => call.path.startsWith(`/containers/create?name=${prefix}`))?.body as {
          HostConfig: { Dns?: string[] };
        };
      return { workspace: body("deskmates-ws-"), proxy: body("deskmates-egress-") };
    };
    const endpoint = { kind: "unix", socketPath: "/nonexistent/docker.sock" } as const;

    const configured = await createBodies(
      new DockerProvider({ endpoint, egressProxyDns: ["223.5.5.5", "2001:4860:4860::8888"] }),
    );
    expect(configured.proxy.HostConfig.Dns).toEqual(["223.5.5.5", "2001:4860:4860::8888"]);
    expect(configured.workspace.HostConfig.Dns).toEqual(["127.0.0.1"]);

    // Unset keeps Docker's embedded resolver: no Dns key at all, not an empty list.
    const unset = await createBodies(new DockerProvider({ endpoint }));
    expect(unset.proxy.HostConfig).not.toHaveProperty("Dns");
    expect(unset.workspace.HostConfig.Dns).toEqual(["127.0.0.1"]);

    for (const bad of [["dns.google"], ["8.8.8.8:53"], [""]]) {
      expect(() => new DockerProvider({ endpoint, egressProxyDns: bad }), bad.join()).toThrow(
        /DNS/,
      );
    }
    // The Gateway hands its whole config to the factory; the setting must reach the provider.
    expect(() => createSandboxProvider({ egressProxyDns: ["dns.google"] })).toThrow(/DNS/);
  });

  it("gives only the egress proxy the configured DoH endpoint (EGRESS_PROXY_DOH_URL, ADR-0010 4a)", async () => {
    const createBodies = async (p: DockerProvider) => {
      const calls = stubClient(p.client, {
        expect: (_method, path) => {
          if (path === "/containers/c1/json") return inspectOf("c1");
          throw new Error(`unexpected ${path}`);
        },
        request: (_method, path) =>
          path.startsWith("/containers/create?name=deskmates-ws-")
            ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
            : { status: 204, body: "" },
      });
      await p.create({
        workspaceId: WS,
        image: "workspace",
        env: {},
        volumes: {},
        ports: [],
        egressAllowlist: ["*"],
      });
      const body = (prefix: string) =>
        calls.find((call) => call.path.startsWith(`/containers/create?name=${prefix}`))?.body as {
          Env?: string[];
          HostConfig: { Dns?: string[] };
        };
      return { workspace: body("deskmates-ws-"), proxy: body("deskmates-egress-") };
    };
    const endpoint = { kind: "unix", socketPath: "/nonexistent/docker.sock" } as const;
    const doh = "https://223.5.5.5/resolve";

    const configured = await createBodies(new DockerProvider({ endpoint, egressProxyDohUrl: doh }));
    expect(configured.proxy.Env).toContain(`DESKMATES_DOH_URL=${doh}`);
    expect(JSON.stringify(configured.workspace)).not.toContain("DESKMATES_DOH_URL");
    expect(JSON.stringify(configured.workspace)).not.toContain(doh);
    // DoH does not change the proxy container's port-53 resolver.
    expect(configured.proxy.HostConfig).not.toHaveProperty("Dns");

    const unset = await createBodies(new DockerProvider({ endpoint }));
    expect(unset.proxy.Env?.some((entry) => entry.startsWith("DESKMATES_DOH_URL="))).toBe(false);

    for (const bad of ["http://223.5.5.5/resolve", "https://dns.alidns.com/resolve", ""]) {
      expect(() => new DockerProvider({ endpoint, egressProxyDohUrl: bad }), bad).toThrow(/DoH/);
    }
    // The Gateway hands its whole config to the factory; the setting must reach the provider.
    expect(() =>
      createSandboxProvider({ egressProxyDohUrl: "https://dns.alidns.com/resolve" }),
    ).toThrow(/DoH/);
  });

  it("fails closed instead of adopting a legacy default-bridge workspace", async () => {
    const p = newProvider();
    stubClient(p.client, {
      expect: (_method, path) => {
        if (path.startsWith(LIST_PREFIX)) {
          return [summary("legacy", "running", managedLabels("ws1"))];
        }
        if (path === "/containers/legacy/json") {
          return {
            ...inspectOf("legacy"),
            HostConfig: { NetworkMode: "default" },
            NetworkSettings: { Ports: {}, Networks: { bridge: { IPAddress: "172.17.0.2" } } },
          };
        }
        throw new Error(`unexpected ${path}`);
      },
    });
    await expect(p.attach(WS)).rejects.toMatchObject({
      code: "sandbox_unavailable",
      details: { reason: "network_mismatch" },
    });
  });

  it("rejects noVNC without the exact effective eight-byte credential and never echoes it", async () => {
    const p = newProvider();
    let error: unknown;
    try {
      await p.create({
        workspaceId: WS,
        image: "workspace",
        env: { [VNC_PASSWORD_ENV]: "secret-value-that-must-not-leak" },
        volumes: {},
        ports: [NOVNC_CONTAINER_PORT],
        egressAllowlist: [],
      });
    } catch (caught) {
      error = caught;
    }
    expect(isDeskmatesError(error) && error.details.reason).toBe("vnc_password_invalid");
    expect(String(error)).not.toContain("secret-value-that-must-not-leak");
  });

  it("reattaches a networkless managed workspace but rejects any existing foreign attachment", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: (_method, path) => {
        if (path.startsWith(LIST_PREFIX)) {
          return [summary("c1", "running", managedLabels("ws1"))];
        }
        if (path === "/containers/c1/json") {
          return {
            ...inspectOf("c1"),
            HostConfig: {
              NetworkMode: networkName(WS),
              ExtraHosts: ["egress-proxy:172.31.0.2"],
            },
            NetworkSettings: { Ports: {}, Networks: {} },
          };
        }
        throw new Error(`unexpected ${path}`);
      },
      request: () => ({ status: 200, body: "" }),
    });
    await p.attach(WS);
    expect(calls).toContainEqual({
      method: "POST",
      path: `/networks/${networkName(WS)}/connect`,
      body: { Container: "c1" },
    });
  });

  it("rejects legacy direct host aliases and a proxy with stale host infrastructure", async () => {
    const legacy = newProvider();
    stubClient(legacy.client, {
      expect: (_method, path) => {
        if (path.startsWith(LIST_PREFIX)) return [summary("c1", "running", managedLabels("ws1"))];
        if (path === "/containers/c1/json")
          return {
            ...inspectOf("c1"),
            HostConfig: {
              NetworkMode: networkName(WS),
              ExtraHosts: ["egress-proxy:172.31.0.2", "host.docker.internal:172.31.0.1"],
            },
          };
        throw new Error(`unexpected ${path}`);
      },
    });
    await expect(legacy.attach(WS)).rejects.toThrow("legacy workspace has a direct host alias");

    const changed = newProvider();
    stubClient(changed.client, {
      proxyHostTarget: "other.example",
      expect: (_method, path) => {
        if (path.startsWith(LIST_PREFIX)) return [summary("c1", "running", managedLabels("ws1"))];
        if (path === "/containers/c1/json") return inspectOf("c1");
        throw new Error(`unexpected ${path}`);
      },
    });
    await expect(changed.attach(WS)).rejects.toThrow(
      "egress proxy host target is missing or mismatched",
    );
  });

  it("publishes only this workspace's private grants in the atomically hashed policy", async () => {
    const entry = {
      workspaceId: WS,
      hostname: "intranet.test",
      address: "10.2.3.4",
      port: 443 as const,
      expiresAt: "2099-01-01T00:00:00Z",
    };
    const p = new DockerProvider({
      privateEgressTargets: [entry, { ...entry, workspaceId: "other_ws", hostname: "other.test" }],
    });
    let input = "";
    const calls = stubClient(p.client, {
      onStdin: (chunk) => {
        input += chunk;
      },
    });
    await p.client.request("POST", "/networks/create", {
      Name: EGRESS_OUTBOUND_NETWORK,
      Internal: false,
      Labels: { [MANAGED_LABEL]: "true" },
    });
    await p.updateEgress(
      { workspaceId: WS, providerRef: "c1", sidecarAddress: "docker-exec://c1" },
      [entry.hostname],
    );
    expect(JSON.parse(input)).toEqual({
      version: 1,
      allowlist: [entry.hostname],
      privateTargets: [entry],
    });
    const cmd = (calls.find((c) => c.path === "/containers/proxy1/exec")?.body as { Cmd: string[] })
      .Cmd;
    const { createHash } = await import("node:crypto");
    expect(cmd.at(-1)).toBe(createHash("sha256").update(input).digest("hex"));
    expect(JSON.stringify(cmd)).not.toContain(entry.address);
  });

  it("reloads policy through the infrastructure-only proxy and removes all workspace objects", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: () => {
        throw new Error("unexpected non-infrastructure expect");
      },
    });
    const handle: SandboxHandle = {
      workspaceId: WS,
      providerRef: "c1",
      sidecarAddress: "docker-exec://c1",
    };
    await p.client.request("POST", "/networks/create", {
      Name: EGRESS_OUTBOUND_NETWORK,
      Internal: false,
      Labels: { [MANAGED_LABEL]: "true" },
    });
    await p.updateEgress(handle, ["api.example.com"]);
    const policyExec = calls.find(
      (call) =>
        call.path === "/containers/proxy1/exec" &&
        (call.body as { AttachStdin?: boolean }).AttachStdin === true,
    );
    expect(policyExec?.body).toMatchObject({ AttachStdin: true });
    // An unchanged policy must not reload: a reload drops every open public connection, and the
    // Gateway reapplies the policy before each run.
    const script = (policyExec?.body as { Cmd?: string[] }).Cmd?.[2] ?? "";
    expect(
      script.startsWith(
        '[ "$(cat /run/deskmates-egress/allowlist.sha256 2>/dev/null)" = "$0" ] && { cat >/dev/null; echo unchanged; exit 0; };',
      ),
    ).toBe(true);
    expect(script.indexOf("kill -HUP 1")).toBeGreaterThan(script.indexOf("exit 0"));

    await p.destroy(handle);
    expect(calls.some((call) => call.path === "/containers/c1?v=false&force=true")).toBe(true);
    expect(calls.some((call) => call.path === "/containers/proxy1?v=false&force=true")).toBe(true);
    expect(
      calls.some(
        (call) => call.method === "DELETE" && call.path === `/networks/${networkName(WS)}`,
      ),
    ).toBe(true);
  });

  // A stopped proxy has no address until Docker starts it, so the pre-start inspect cannot be
  // the one `attach` compares against the workspace's pinned alias. Returning it made every
  // attach that had to start a stopped proxy fail with "address is missing or stale", which
  // blocked three real evaluation runs (docs/design/frames-current-runtime-2026-09-26.md).
  it("re-inspects the managed proxy after starting it, so its address is the started one", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      proxyStopped: true,
      expect: (_method, path) => {
        if (path.startsWith(LIST_PREFIX)) {
          return [summary("c1", "running", managedLabels("ws1"))];
        }
        if (path === "/containers/c1/json") return inspectOf("c1");
        throw new Error(`unexpected ${path}`);
      },
    });

    const handle = await p.attach(WS);

    expect(handle?.providerRef).toBe("c1");
    const proxyCalls = calls.filter((call) => call.path.startsWith("/containers/proxy1"));
    const startedAt = proxyCalls.findIndex((call) => call.path === "/containers/proxy1/start");
    const inspectedAfter = proxyCalls.findIndex(
      (call, index) => index > startedAt && call.path === "/containers/proxy1/json",
    );
    expect(startedAt, "the stopped proxy is started").toBeGreaterThanOrEqual(0);
    expect(inspectedAfter, "and inspected again afterwards").toBeGreaterThan(startedAt);
  });
});

describe("DockerProvider.removeStaleSandbox: an upgrade replaces stale containers", () => {
  const WORKSPACE_IMAGE = "deskmates/workspace:v2";
  const PROXY_IMAGE = "deskmates/egress-proxy:v2";
  const IMAGE_IDS: Record<string, string> = {
    [WORKSPACE_IMAGE]: "sha256:ws-v2",
    [PROXY_IMAGE]: "sha256:proxy-v2",
  };

  function upgradeProvider(): DockerProvider {
    return new DockerProvider({
      endpoint: { kind: "unix", socketPath: "/nonexistent/docker.sock" },
      egressProxyImage: PROXY_IMAGE,
    });
  }

  function containerSummary(id: string, role: string, imageId: string, state = "running") {
    return {
      Id: id,
      State: state,
      ImageID: imageId,
      Labels: { [WORKSPACE_LABEL]: "ws1", [MANAGED_LABEL]: "true", [ROLE_LABEL]: role },
    };
  }

  /** The daemon's view: which containers the workspace has and which images are present. */
  function stubUpgrade(
    p: DockerProvider,
    containers: ReturnType<typeof containerSummary>[],
    images: Record<string, string> = IMAGE_IDS,
  ): Call[] {
    return stubClient(p.client, {
      expect: (_m, path) => {
        if (path.startsWith(LIST_PREFIX)) return containers;
        throw new Error(`unexpected ${path}`);
      },
      request: (method, path) => {
        if (method === "GET" && path.startsWith("/images/")) {
          const ref = decodeURIComponent(path.slice("/images/".length, -"/json".length));
          const id = images[ref];
          return id === undefined
            ? { status: 404, body: JSON.stringify({ message: `No such image: ${ref}` }) }
            : { status: 200, body: JSON.stringify({ Id: id }) };
        }
        return { status: 204, body: "" };
      },
    });
  }

  const removals = (calls: Call[]) =>
    calls.filter((c) => c.method === "DELETE" && c.path.startsWith("/containers/"));

  it("leaves a sandbox whose workspace and proxy run the configured images alone", async () => {
    const p = upgradeProvider();
    const calls = stubUpgrade(p, [
      containerSummary("c1", "workspace", "sha256:ws-v2"),
      containerSummary("proxy1", EGRESS_PROXY_ROLE, "sha256:proxy-v2"),
    ]);
    expect(await p.removeStaleSandbox(WS, WORKSPACE_IMAGE)).toEqual([]);
    expect(removals(calls)).toEqual([]);
    expect(calls.some((c) => c.path.includes("/stop"))).toBe(false);
  });

  it("removes both containers but never their volumes when the workspace image changed", async () => {
    const p = upgradeProvider();
    const calls = stubUpgrade(p, [
      containerSummary("c1", "workspace", "sha256:ws-v1"),
      containerSummary("proxy1", EGRESS_PROXY_ROLE, "sha256:proxy-v2"),
    ]);
    expect(await p.removeStaleSandbox(WS, WORKSPACE_IMAGE)).toEqual([
      { component: "workspace", runningImageId: "sha256:ws-v1", configuredImageId: "sha256:ws-v2" },
    ]);
    // `v=false`: the named volumes (/profile, /work, /home) outlive the container.
    expect(removals(calls).map((c) => c.path)).toEqual([
      "/containers/c1?v=false&force=true",
      "/containers/proxy1?v=false&force=true",
    ]);
    // The resolution is by inspect only; nothing is pulled, built or loaded.
    const imageCalls = calls.filter((c) => c.path.startsWith("/images/"));
    expect(imageCalls.every((c) => c.method === "GET" && c.path.endsWith("/json"))).toBe(true);
  });

  it("replaces the pair when only the egress proxy runs a stale image", async () => {
    const p = upgradeProvider();
    const calls = stubUpgrade(p, [
      containerSummary("c1", "workspace", "sha256:ws-v2"),
      containerSummary("proxy1", EGRESS_PROXY_ROLE, "sha256:proxy-v1"),
    ]);
    expect(await p.removeStaleSandbox(WS, WORKSPACE_IMAGE)).toEqual([
      {
        component: EGRESS_PROXY_ROLE,
        runningImageId: "sha256:proxy-v1",
        configuredImageId: "sha256:proxy-v2",
      },
    ]);
    // The workspace pins the proxy's address in /etc/hosts at create, so it goes too.
    expect(removals(calls).map((c) => c.path)).toEqual([
      "/containers/c1?v=false&force=true",
      "/containers/proxy1?v=false&force=true",
    ]);
  });

  it("also clears a leftover stopped container so the following create is not refused", async () => {
    const p = upgradeProvider();
    const calls = stubUpgrade(p, [
      containerSummary("old", "workspace", "sha256:ws-v0", "exited"),
      containerSummary("c1", "workspace", "sha256:ws-v1"),
      containerSummary("proxy1", EGRESS_PROXY_ROLE, "sha256:proxy-v2"),
    ]);
    const drift = await p.removeStaleSandbox(WS, WORKSPACE_IMAGE);
    // The drift reported is the container attach would have chosen: the running one.
    expect(drift.map((d) => d.runningImageId)).toEqual(["sha256:ws-v1"]);
    expect(removals(calls).map((c) => c.path)).toContain("/containers/old?v=false&force=true");
  });

  it.each([
    ["workspace", { [PROXY_IMAGE]: "sha256:proxy-v2" }, WORKSPACE_IMAGE],
    ["egress proxy", { [WORKSPACE_IMAGE]: "sha256:ws-v2" }, PROXY_IMAGE],
  ])(
    "fails closed with image_missing when the configured %s image is absent",
    async (_which, images, missing) => {
      const p = upgradeProvider();
      const calls = stubUpgrade(
        p,
        [
          containerSummary("c1", "workspace", "sha256:ws-v1"),
          containerSummary("proxy1", EGRESS_PROXY_ROLE, "sha256:proxy-v1"),
        ],
        images,
      );
      let err: unknown;
      try {
        await p.removeStaleSandbox(WS, WORKSPACE_IMAGE);
      } catch (e) {
        err = e;
      }
      expect(isDeskmatesError(err) && err.code).toBe("sandbox_unavailable");
      expect(isDeskmatesError(err) && err.details).toMatchObject({
        reason: "image_missing",
        image: missing,
      });
      // Nothing was stopped or removed: the old sandbox keeps working until the image exists.
      expect(removals(calls)).toEqual([]);
      expect(calls.some((c) => c.path.includes("/stop"))).toBe(false);
    },
  );

  it("does nothing, and resolves nothing, for a workspace with no containers", async () => {
    const p = upgradeProvider();
    const calls = stubUpgrade(p, [], {});
    expect(await p.removeStaleSandbox(WS, WORKSPACE_IMAGE)).toEqual([]);
    expect(calls.some((c) => c.path.startsWith("/images/"))).toBe(false);
  });

  it("the attach that follows a removal finds nothing, so the caller creates afresh", async () => {
    const p = upgradeProvider();
    const containers = [
      containerSummary("c1", "workspace", "sha256:ws-v1"),
      containerSummary("proxy1", EGRESS_PROXY_ROLE, "sha256:proxy-v2"),
    ];
    stubUpgrade(p, containers);
    await p.removeStaleSandbox(WS, WORKSPACE_IMAGE);
    containers.splice(0);
    expect(await p.attach(WS)).toBeUndefined();
  });
});

describe("DockerProvider.exec: a broken stream is an error, not truncated output (L4)", () => {
  const handle: SandboxHandle = {
    workspaceId: WS,
    providerRef: "c1",
    sidecarAddress: "docker-exec://c1",
  };

  /** `drive` is called per exec; `nth` is 0 for the caller's exec, 1+ for the timeout killer. */
  function stubExec(p: DockerProvider, drive: (socket: PassThrough, nth: number) => void): void {
    let nth = 0;
    stubClient(p.client, {
      expect: (_m, path) => {
        if (path.endsWith("/exec")) return { Id: "exec-1" };
        if (path === "/exec/exec-1/json") return { Running: false, ExitCode: 0 };
        throw new Error(`unexpected ${path}`);
      },
      hijack: () => {
        const socket = new PassThrough();
        const n = nth;
        nth += 1;
        // After the provider has attached its listeners, not before.
        setImmediate(() => drive(socket, n));
        return { socket: socket as unknown as Socket, head: Buffer.alloc(0) };
      },
    });
  }

  it("a clean stream still returns stdout and the exit code", async () => {
    const p = newProvider();
    stubExec(p, (s) => {
      s.write(encodeDockerFrame(1, "hello\n"));
      s.end();
    });
    expect(await p.exec(handle, { cmd: ["echo", "hello"] })).toEqual({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
  });

  it("a socket error mid-stream throws instead of reporting a successful exit code", async () => {
    const p = newProvider();
    stubExec(p, (s) => {
      s.write(encodeDockerFrame(1, "first half\n"));
      s.destroy(new Error("ECONNRESET from the daemon"));
    });
    let err: unknown;
    try {
      await p.exec(handle, { cmd: ["cat", "/big"] });
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.code).toBe("sandbox_unavailable");
    expect(isDeskmatesError(err) && err.details.reason).toBe("stream_error");
  });

  it("bytes left over from a partial frame throw: the output would be truncated", async () => {
    const p = newProvider();
    const frame = encodeDockerFrame(1, "abcdefghij");
    stubExec(p, (s) => {
      s.write(frame.subarray(0, 12));
      s.end();
    });
    let err: unknown;
    try {
      await p.exec(handle, { cmd: ["cat", "/big"] });
    } catch (e) {
      err = e;
    }
    expect(isDeskmatesError(err) && err.code).toBe("sandbox_unavailable");
    expect(isDeskmatesError(err) && err.details.reason).toBe("stream_error");
    expect(isDeskmatesError(err) && err.details.pendingBytes).toBe(12);
  });

  it("a timeout keeps returning the partial output: that is what the caller asked for", async () => {
    const p = newProvider();
    stubExec(p, (s, nth) => {
      if (nth > 0) {
        s.end(); // the follow-up exec that kills the timed-out process tree
        return;
      }
      s.write(encodeDockerFrame(1, "before\n"));
      // and never ends; the provider's timer destroys the socket
    });
    const r = await p.exec(handle, { cmd: ["sleep", "30"], timeoutMs: 100 });
    expect(r).toEqual({ stdout: "before\n", stderr: "", exitCode: -1, timedOut: true });
  });

  it("an abort ends the exec like a deadline and kills the process tree", async () => {
    const p = newProvider();
    const kills: number[] = [];
    stubExec(p, (s, nth) => {
      if (nth > 0) {
        kills.push(nth);
        s.end();
        return;
      }
      s.write(encodeDockerFrame(1, "working\n"));
    });
    const controller = new AbortController();
    const pending = p.exec(handle, { cmd: ["sleep", "30"], signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await pending).toEqual({
      stdout: "working\n",
      stderr: "",
      exitCode: -1,
      timedOut: true,
    });
    expect(kills).toEqual([1]);
  });

  it("an exec whose signal is already aborted is killed at once", async () => {
    const p = newProvider();
    let kills = 0;
    stubExec(p, (s, nth) => {
      if (nth > 0) kills += 1;
      else s.write(encodeDockerFrame(1, "x"));
      if (nth > 0) s.end();
    });
    const r = await p.exec(handle, { cmd: ["sleep", "30"], signal: AbortSignal.abort() });
    expect(r.timedOut).toBe(true);
    expect(kills).toBe(1);
  });
});

it.each([false, true])(
  "requires image-declared screen support, not only Gateway environment (capable=%s)",
  async (capable) => {
    const provider = newProvider();
    stubClient(provider.client, {
      proxyPorts: Object.fromEntries(
        Array.from({ length: 7 }, (_, i) => [
          `${6080 + i}/tcp`,
          [{ HostIp: "127.0.0.1", HostPort: String(49160 + i) }],
        ]),
      ),
      expect: (_method, path) => {
        if (path !== "/containers/c1/json") throw new Error(`unexpected ${path}`);
        return {
          ...inspectOf("c1"),
          Config: {
            Env: [
              "DESKMATES_VNC_PASSWORD=deadbeef",
              "DESKMATES_VNC_VIEW_PASSWORD=cafe1234",
              "DESKMATES_DESKTOP_MODE=shared-monitors-v1",
            ],
            Labels: {
              ...managedLabels("ws1"),
              ...(capable ? { "deskmates.desktop.mode": "shared-monitors-v1" } : {}),
            },
          },
        };
      },
      request: (_method, path) =>
        path.startsWith("/containers/create")
          ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
          : { status: 204, body: "" },
    });
    const handle = await provider.create({
      workspaceId: WS,
      image: "img",
      env: { [VNC_PASSWORD_ENV]: "deadbeef" },
      volumes: {},
      ports: [NOVNC_CONTAINER_PORT],
      egressAllowlist: [],
    });
    expect(handle.novncAddress).toBe("127.0.0.1:49160");
    expect(handle.botScreenAddresses?.length).toBe(capable ? 6 : undefined);
  },
);

describe("app relay (ADR-0035 decision 4)", () => {
  const create = async (proxyEnv: string[], proxyPorts: NonNullable<Stub["proxyPorts"]>) => {
    const provider = newProvider();
    const calls = stubClient(provider.client, {
      proxyPorts,
      proxyEnv,
      expect: (_method, path) => {
        if (path !== "/containers/c1/json") throw new Error(`unexpected ${path}`);
        return inspectOf("c1");
      },
      request: (_method, path) =>
        path.startsWith("/containers/create")
          ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
          : { status: 204, body: "" },
    });
    const handle = await provider.create({
      workspaceId: WS,
      image: "img",
      env: {},
      volumes: {},
      ports: [],
      egressAllowlist: [],
    });
    return { calls, handle };
  };
  const relayPorts = { "6090/tcp": [{ HostIp: "127.0.0.1", HostPort: "49190" }] };

  it("publishes the relay from the proxy with a fresh key and nothing from the workspace", async () => {
    const { calls } = await create([], relayPorts);
    const bodies = calls
      .filter((c) => c.method === "POST" && c.path.startsWith("/containers/create"))
      .map((c) => ({
        path: c.path,
        body: c.body as { Env: string[]; HostConfig: { PortBindings: Record<string, unknown> } },
      }));
    const proxy = bodies.find((b) => b.path.includes("deskmates-egress-"))?.body;
    const workspace = bodies.find((b) => b.path.includes("deskmates-ws-"))?.body;
    expect(proxy?.HostConfig.PortBindings["6090/tcp"]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "" },
    ]);
    expect(proxy?.Env.find((e: string) => e.startsWith(`${APP_RELAY_KEY_ENV}=`))).toMatch(
      /^DESKMATES_APP_RELAY_KEY=[0-9a-f]{32}$/,
    );
    expect(workspace?.HostConfig.PortBindings).toEqual({});
  });

  it("hands the Gateway the relay address and key read back from the proxy", async () => {
    const key = "ab".repeat(16);
    const { handle } = await create([`${APP_RELAY_KEY_ENV}=${key}`], relayPorts);
    expect(handle.appRelayAddress).toBe("127.0.0.1:49190");
    expect(handle.appRelayKey).toBe(key);
  });

  it("reports no relay for a proxy from before the relay existed", async () => {
    const { handle } = await create([], {});
    expect(handle.appRelayAddress).toBeUndefined();
    expect(handle.appRelayKey).toBeUndefined();
  });
});

describe("DockerProvider tenant ownership labels (ADR-0022 DOCKER-01)", () => {
  it("labels the workspace container, its proxy and its network with the owning tenant", async () => {
    const p = newProvider();
    const calls = stubClient(p.client, {
      expect: (_method, path) => {
        if (path === "/containers/c1/json") return inspectOf("c1");
        throw new Error(`unexpected ${path}`);
      },
      request: (_method, path) =>
        path.startsWith("/containers/create?name=deskmates-ws-")
          ? { status: 201, body: JSON.stringify({ Id: "c1" }) }
          : { status: 204, body: "" },
    });
    await p.create({
      workspaceId: WS,
      tenantId: "tnt_a",
      image: "workspace",
      env: {},
      volumes: {},
      ports: [],
      egressAllowlist: [],
    });
    const labelsOf = (prefix: string) =>
      (calls.find((c) => c.path.startsWith(prefix))?.body as { Labels: Record<string, string> })
        .Labels;
    expect(labelsOf("/containers/create?name=deskmates-ws-")[TENANT_LABEL]).toBe("tnt_a");
    expect(labelsOf("/containers/create?name=deskmates-egress-")[TENANT_LABEL]).toBe("tnt_a");
    const workspaceNetwork = calls.find(
      (c) => c.path === "/networks/create" && (c.body as { Name: string }).Name === networkName(WS),
    )?.body as { Labels: Record<string, string> };
    expect(workspaceNetwork.Labels[TENANT_LABEL]).toBe("tnt_a");
  });

  it("refuses to attach a sandbox labelled for another tenant, or an unlabelled one outside the Default Tenant", async () => {
    const attachWith = async (labels: Record<string, string>, tenantId: string) => {
      const p = newProvider();
      const calls = stubClient(p.client, {
        expect: (_m, path) => {
          if (path.startsWith(LIST_PREFIX)) return [summary("c1", "running", labels)];
          if (path === "/containers/c1/json") return inspectOf("c1");
          throw new Error(`unexpected ${path}`);
        },
      });
      try {
        await p.attach(WS, tenantId);
        return { refused: false, calls };
      } catch (error) {
        expect(isDeskmatesError(error) && error.code).toBe("sandbox_unavailable");
        return { refused: true, calls };
      }
    };
    const foreign = await attachWith({ ...managedLabels("ws1"), [TENANT_LABEL]: "tnt_b" }, "tnt_a");
    expect(foreign.refused).toBe(true);
    // Refused before anything about the container is read or started.
    expect(foreign.calls.some((c) => c.path === "/containers/c1/json")).toBe(false);
    expect((await attachWith(managedLabels("ws1"), "tnt_a")).refused).toBe(true);
    // Positive controls: the owner's label, and a pre-tenant sandbox in the Default Tenant, pass
    // the ownership check (whatever the later network checks of the stub decide).
    for (const [labels, tenant] of [
      [{ ...managedLabels("ws1"), [TENANT_LABEL]: "tnt_a" }, "tnt_a"],
      [managedLabels("ws1"), "tnt_default"],
    ] as const) {
      const result = await attachWith(labels, tenant);
      expect(result.calls.some((c) => c.path === "/containers/c1/json")).toBe(true);
    }
  });
});
