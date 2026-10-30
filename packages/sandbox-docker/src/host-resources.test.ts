// T0: ADR-0006 amendment 5 in the Docker provider, against an in-memory Engine API. Decision 11:
// what `listHostResources` reads, with GET requests only. Decision 13: what `removeHostResources`
// deletes and in which order, and how `reattachWorkspaceNetwork` puts a container back on its own
// network. The behaviour against a real daemon is in host-resources.container.test.ts.

import { type WorkspaceId, isDeskmatesError } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { DockerClient } from "./docker-client.js";
import {
  DockerProvider,
  EGRESS_OUTBOUND_NETWORK,
  EGRESS_PROXY_ROLE,
  MANAGED_LABEL,
  ROLE_LABEL,
  WORKSPACE_LABEL,
  containerName,
  networkName,
  proxyName,
} from "./docker-provider.js";

type Labels = Record<string, string>;

interface FakeContainer {
  Id: string;
  Name: string;
  State: string;
  Labels: Labels;
  NetworkMode: string;
  ExtraHosts: string[];
  Networks: Record<string, { IPAddress: string; Aliases?: string[] }>;
  Processes: string[];
  SizeRw?: number;
}

interface FakeNetwork {
  Id: string;
  Name: string;
  Labels: Labels;
  Internal: boolean;
  Subnet: string;
  Created: string;
}

/** A small Engine API: containers, networks, volumes, `/info` and `/system/df`. */
class FakeDaemon {
  readonly calls: string[] = [];
  readonly containers = new Map<string, FakeContainer>();
  readonly networks = new Map<string, FakeNetwork>();
  readonly volumes = new Map<string, { Name: string; Labels: Labels; Size: number }>();
  pools: { Base: string; Size: number }[] | undefined;
  /** Addresses the daemon refuses to hand out on connect, as a taken or foreign address. */
  readonly refusedAddresses = new Set<string>();
  private nextSubnet = 1;

  network(name: string, labels: Labels, internal = true): FakeNetwork {
    const n: FakeNetwork = {
      Id: `net-${name}`,
      Name: name,
      Labels: labels,
      Internal: internal,
      Subnet: `10.200.${this.nextSubnet++}.0/24`,
      Created: "2026-10-16T08:00:00.000Z",
    };
    this.networks.set(name, n);
    return n;
  }

  container(c: Omit<FakeContainer, "Processes" | "ExtraHosts"> & Partial<FakeContainer>) {
    this.containers.set(c.Id, { Processes: [], ExtraHosts: [], ...c });
  }

  private attached(name: string): Record<string, unknown> {
    return Object.fromEntries(
      [...this.containers.values()]
        .filter((c) => c.Networks[name] !== undefined)
        .map((c) => [c.Id, {}]),
    );
  }

  private matches(labels: Labels, query: string): boolean {
    const raw = new URLSearchParams(query).get("filters");
    if (!raw) return true;
    const wanted = (JSON.parse(raw) as { label?: string[] }).label ?? [];
    return wanted.every((pair) => {
      const [key, value] = pair.split("=");
      return labels[key ?? ""] === value;
    });
  }

  handle(method: string, url: string, body: unknown): { status: number; json?: unknown } {
    this.calls.push(`${method} ${url.split("?")[0]}`);
    const [path = "", query = ""] = url.split("?");
    const parts = path.split("/").map(decodeURIComponent);
    if (method === "GET" && path === "/containers/json")
      return {
        status: 200,
        json: [...this.containers.values()]
          .filter((c) => this.matches(c.Labels, query))
          .map((c) => ({
            Id: c.Id,
            Names: [`/${c.Name}`],
            State: c.State,
            Labels: c.Labels,
            Created: 1_760_000_000,
            ...(c.SizeRw === undefined ? {} : { SizeRw: c.SizeRw }),
          })),
      };
    if (parts[1] === "containers") {
      const c = this.containers.get(parts[2] ?? "");
      if (!c) return { status: 404, json: { message: "no such container" } };
      if (method === "GET" && parts[3] === "json")
        return {
          status: 200,
          json: {
            Id: c.Id,
            Name: `/${c.Name}`,
            State: { Running: c.State === "running", Status: c.State },
            Config: { Labels: c.Labels, Env: [] },
            HostConfig: { NetworkMode: c.NetworkMode, ExtraHosts: c.ExtraHosts },
            NetworkSettings: { Networks: c.Networks },
          },
        };
      if (method === "GET" && parts[3] === "top")
        return {
          status: 200,
          json: { Titles: ["UID", "PID", "CMD"], Processes: c.Processes.map((p) => ["0", "1", p]) },
        };
      if (method === "POST" && parts[3] === "stop") return { status: 204 };
      if (method === "DELETE") {
        this.containers.delete(c.Id);
        return { status: 204 };
      }
    }
    if (method === "GET" && path === "/networks")
      return {
        status: 200,
        json: [...this.networks.values()]
          .filter((n) => this.matches(n.Labels, query))
          .map((n) => ({
            Id: n.Id,
            Name: n.Name,
            Labels: n.Labels,
            Created: n.Created,
            IPAM: { Config: [{ Subnet: n.Subnet }] },
          })),
      };
    if (method === "POST" && path === "/networks/create") {
      const b = body as { Name: string; Labels: Labels; Internal: boolean };
      this.network(b.Name, b.Labels, b.Internal);
      return { status: 201, json: { Id: `net-${b.Name}` } };
    }
    if (parts[1] === "networks") {
      const n = this.networks.get(parts[2] ?? "");
      if (!n) return { status: 404, json: { message: "no such network" } };
      if (method === "GET")
        return {
          status: 200,
          json: {
            Id: n.Id,
            Name: n.Name,
            Internal: n.Internal,
            Labels: n.Labels,
            IPAM: { Config: [{ Subnet: n.Subnet, Gateway: n.Subnet.replace(/0\/24$/, "1") }] },
            Containers: this.attached(n.Name),
          },
        };
      if (method === "DELETE") {
        if (Object.keys(this.attached(n.Name)).length > 0) return { status: 403, json: {} };
        this.networks.delete(n.Name);
        return { status: 204 };
      }
      const b = body as {
        Container: string;
        EndpointConfig?: { Aliases?: string[]; IPAMConfig?: { IPv4Address: string } };
      };
      const c = this.containers.get(b.Container);
      if (!c) return { status: 404, json: {} };
      if (parts[3] === "disconnect") {
        delete c.Networks[n.Name];
        return { status: 200 };
      }
      if (parts[3] === "connect") {
        const wanted = b.EndpointConfig?.IPAMConfig?.IPv4Address;
        if (wanted !== undefined && this.refusedAddresses.has(wanted))
          return { status: 403, json: { message: "address unavailable" } };
        c.Networks[n.Name] = {
          IPAddress: wanted ?? n.Subnet.replace(/0\/24$/, "9"),
          ...(b.EndpointConfig?.Aliases ? { Aliases: b.EndpointConfig.Aliases } : {}),
        };
        return { status: 200 };
      }
    }
    if (method === "GET" && path === "/volumes")
      return {
        status: 200,
        json: {
          Volumes: [...this.volumes.values()]
            .filter((v) => this.matches(v.Labels, query))
            .map((v) => ({ Name: v.Name, Labels: v.Labels, CreatedAt: "2026-10-15T00:00:00Z" })),
        },
      };
    if (method === "DELETE" && parts[1] === "volumes") {
      this.volumes.delete(parts[2] ?? "");
      return { status: 204 };
    }
    if (method === "GET" && path === "/system/df")
      return {
        status: 200,
        json: {
          Volumes: [...this.volumes.values()].map((v) => ({
            Name: v.Name,
            UsageData: { Size: v.Size },
          })),
        },
      };
    if (method === "GET" && path === "/info")
      return { status: 200, json: this.pools ? { DefaultAddressPools: this.pools } : {} };
    throw new Error(`unscripted ${method} ${url}`);
  }

  provider(): DockerProvider {
    const p = new DockerProvider({ endpoint: { kind: "unix", socketPath: "/nonexistent.sock" } });
    const request = async (method: string, path: string, body?: unknown) => {
      const { status, json } = this.handle(method, path, body);
      return { status, body: json === undefined ? "" : JSON.stringify(json) };
    };
    const expectFn = async (method: string, path: string, body?: unknown) => {
      const { status, json } = this.handle(method, path, body);
      if (![200, 201, 204].includes(status)) throw new Error(`${method} ${path}: ${status}`);
      return { status, json };
    };
    Object.assign(p.client, { request, expect: expectFn } as unknown as Partial<DockerClient>);
    return p;
  }
}

const managed = (workspaceId: string, role: string): Labels => ({
  [WORKSPACE_LABEL]: workspaceId,
  [MANAGED_LABEL]: "true",
  [ROLE_LABEL]: role,
});

/** One workspace as `create` leaves it: container, proxy, network, outbound network, volumes. */
function workspace(d: FakeDaemon, id: string, options: { sidecar?: boolean } = {}): void {
  const own = networkName(id as WorkspaceId);
  if (!d.networks.has(EGRESS_OUTBOUND_NETWORK))
    d.network(EGRESS_OUTBOUND_NETWORK, { [MANAGED_LABEL]: "true" }, false);
  d.network(own, { [MANAGED_LABEL]: "true", [WORKSPACE_LABEL]: id });
  const proxyIp = d.networks.get(own)?.Subnet.replace(/0\/24$/, "2") ?? "";
  d.container({
    Id: `${id}-proxy`,
    Name: proxyName(id as WorkspaceId),
    State: "running",
    Labels: managed(id, EGRESS_PROXY_ROLE),
    NetworkMode: own,
    Networks: {
      [own]: { IPAddress: proxyIp, Aliases: ["egress-proxy"] },
      [EGRESS_OUTBOUND_NETWORK]: { IPAddress: "172.29.0.2" },
    },
  });
  d.container({
    Id: `${id}-ws`,
    Name: containerName(id as WorkspaceId),
    State: "running",
    Labels: managed(id, "workspace"),
    NetworkMode: own,
    ExtraHosts: [`egress-proxy:${proxyIp}`],
    Networks: { [own]: { IPAddress: proxyIp.replace(/2$/, "3"), Aliases: ["desk"] } },
    Processes: options.sidecar ? ["/usr/bin/node /opt/deskmates-sidecar run"] : ["/sbin/init"],
    SizeRw: 4096,
  });
  for (const suffix of ["profile", "work", "home"])
    d.volumes.set(`deskmates-${id}-${suffix}`, {
      Name: `deskmates-${id}-${suffix}`,
      Labels: { [MANAGED_LABEL]: "true", [WORKSPACE_LABEL]: id },
      Size: 1000,
    });
}

const WS_HEX = `ws_${"a".repeat(32)}`;

describe("listHostResources (decision 11)", () => {
  it("lists what the provider owns with workspace, size and age, reading only", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_live");
    workspace(d, "ws_t2", { sidecar: true });
    d.pools = [{ Base: "10.200.0.0/16", Size: 24 }];
    const inventory = await d.provider().listHostResources();

    expect(d.calls.every((call) => call.startsWith("GET "))).toBe(true);
    expect(inventory.addressPools).toEqual([{ base: "10.200.0.0/16", size: 24 }]);
    expect(inventory.subnets.map((s) => s.name)).toContain(networkName("ws_live" as WorkspaceId));
    const byName = new Map(inventory.resources.map((r) => [r.name, r]));
    expect(byName.get("deskmates-ws-ws_live")).toMatchObject({
      kind: "container",
      workspaceId: "ws_live",
      role: "workspace",
      sizeBytes: 4096,
      state: "running",
      sidecarProcesses: 0,
      createdAt: "2025-10-09T08:53:20.000Z",
    });
    expect(byName.get("deskmates-ws-ws_live")?.topologyProblem).toBeUndefined();
    expect(byName.get("deskmates-ws-ws_t2")?.sidecarProcesses).toBe(1);
    expect(byName.get("deskmates-net-ws_live")).toMatchObject({
      kind: "network",
      role: "workspace",
      attachedContainers: 2,
    });
    expect(byName.get("deskmates-ws_live-work")).toMatchObject({ kind: "volume", sizeBytes: 1000 });
    // The shared outbound network belongs to no workspace and is not listed.
    expect(byName.has(EGRESS_OUTBOUND_NETWORK)).toBe(false);
  });

  it("reports a container on another network as a topology problem", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_live");
    d.network("vendordb-demo-net", {});
    const c = d.containers.get("ws_live-ws");
    if (c) c.Networks["vendordb-demo-net"] = { IPAddress: "10.200.9.9" };
    const inventory = await d.provider().listHostResources();
    expect(inventory.resources.find((r) => r.id === "ws_live-ws")?.topologyProblem).toBe(
      "workspace is attached to a legacy or mismatched network",
    );
  });

  it("matches former-name networks by the naming and labelling rule only", async () => {
    const d = new FakeDaemon();
    d.network("former-net-ws_x", { "former.managed": "true", "former.workspace": "ws_x" });
    d.network(`former-net-${WS_HEX}`, {});
    d.network("former-egress-outbound", { "former.managed": "true" }, false);
    d.network("former-net-misc", {});
    d.network("myapp-egress-outbound", {}, false);
    d.network("bridge", {}, false);
    const inventory = await d.provider().listHostResources();
    expect(
      inventory.resources.map((r) => [r.name, r.role, r.workspaceId, r.attachedContainers]),
    ).toEqual([
      ["former-net-ws_x", "legacy", "ws_x", 0],
      [`former-net-${WS_HEX}`, "legacy", WS_HEX, 0],
      ["former-egress-outbound", "legacy", undefined, 0],
    ]);
    expect(inventory.addressPools).toBeUndefined();
  });
});

describe("removeHostResources (decision 13)", () => {
  it("removes the workspace container, then the proxy, the network and the volumes", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_t2");
    workspace(d, "ws_live");
    const removed = await d.provider().removeHostResources({
      kind: "workspace",
      workspaceId: "ws_t2",
      keepVolumes: false,
    });
    expect(removed.map((r) => r.name)).toEqual([
      "deskmates-ws-ws_t2",
      "deskmates-egress-ws_t2",
      "deskmates-net-ws_t2",
      "deskmates-ws_t2-profile",
      "deskmates-ws_t2-work",
      "deskmates-ws_t2-home",
    ]);
    const deletes = d.calls.filter((c) => c.startsWith("DELETE "));
    expect(deletes).toEqual([
      "DELETE /containers/ws_t2-ws",
      "DELETE /containers/ws_t2-proxy",
      `DELETE /networks/${networkName("ws_t2" as WorkspaceId)}`,
      "DELETE /volumes/deskmates-ws_t2-profile",
      "DELETE /volumes/deskmates-ws_t2-work",
      "DELETE /volumes/deskmates-ws_t2-home",
    ]);
    // The other workspace is untouched.
    expect(d.containers.has("ws_live-ws")).toBe(true);
    expect(d.networks.has(networkName("ws_live" as WorkspaceId))).toBe(true);
    expect(d.volumes.size).toBe(3);
  });

  it("keeps the volumes of an archived workspace", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_old");
    const removed = await d.provider().removeHostResources({
      kind: "workspace",
      workspaceId: "ws_old",
      keepVolumes: true,
    });
    expect(removed.map((r) => r.kind)).toEqual(["container", "container", "network"]);
    expect(d.volumes.size).toBe(3);
  });

  it("removes a former-name network only while nothing is attached and the rule matches", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_live");
    d.network("former-net-ws_live", { "former.managed": "true", "former.workspace": "ws_live" });
    d.network("plane", {});
    const c = d.containers.get("ws_live-ws");
    if (c) c.Networks["former-net-ws_live"] = { IPAddress: "10.200.9.9" };
    const p = d.provider();
    const busy = await p
      .removeHostResources({ kind: "network", name: "former-net-ws_live" })
      .catch((e: unknown) => e);
    expect(isDeskmatesError(busy) && busy.code).toBe("invalid_transition");
    const foreign = await p
      .removeHostResources({ kind: "network", name: "plane" })
      .catch((e: unknown) => e);
    expect(isDeskmatesError(foreign) && foreign.code).toBe("validation");
    if (c) c.Networks = { [networkName("ws_live" as WorkspaceId)]: { IPAddress: "10.200.1.3" } };
    expect(
      (await p.removeHostResources({ kind: "network", name: "former-net-ws_live" })).map(
        (r) => r.name,
      ),
    ).toEqual(["former-net-ws_live"]);
    expect(d.networks.has("plane")).toBe(true);
  });
});

describe("reattachWorkspaceNetwork (decision 13)", () => {
  it("moves a container moved by hand back onto its own network with its aliases", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_live");
    d.network("wrong-net", {});
    const own = networkName("ws_live" as WorkspaceId);
    const c = d.containers.get("ws_live-ws");
    if (!c) throw new Error("fixture");
    c.Networks = { "wrong-net": { IPAddress: "10.200.9.9", Aliases: ["desk", "ws_live-ws"] } };
    const result = await d.provider().reattachWorkspaceNetwork("ws_live" as WorkspaceId);
    expect(result).toEqual({});
    expect(Object.keys(c.Networks)).toEqual([own]);
    expect(c.Networks[own]?.Aliases).toEqual(["desk"]);
    expect(d.calls).toContain("POST /networks/wrong-net/disconnect");
  });

  it("creates a missing own network and joins the proxy at the pinned address", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_live");
    const own = networkName("ws_live" as WorkspaceId);
    const pinned = d.containers.get("ws_live-ws")?.ExtraHosts[0]?.split(":")[1];
    d.network("former-net-ws_live", { "former.managed": "true", "former.workspace": "ws_live" });
    for (const id of ["ws_live-ws", "ws_live-proxy"]) {
      const c = d.containers.get(id);
      if (!c) continue;
      const own_ = c.Networks[own];
      delete c.Networks[own];
      c.Networks["former-net-ws_live"] = own_ ?? { IPAddress: "" };
    }
    d.networks.delete(own);
    const result = await d.provider().reattachWorkspaceNetwork("ws_live" as WorkspaceId);
    expect(result).toEqual({});
    expect(d.calls).toContain("POST /networks/create");
    const proxy = d.containers.get("ws_live-proxy");
    expect(Object.keys(proxy?.Networks ?? {}).sort()).toEqual(
      [EGRESS_OUTBOUND_NETWORK, own].sort(),
    );
    expect(proxy?.Networks[own]).toEqual({ IPAddress: pinned, Aliases: ["egress-proxy"] });
  });

  it("reports what is still wrong instead of claiming a repair", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_live");
    const c = d.containers.get("ws_live-ws");
    if (c) c.NetworkMode = "wrong-net";
    expect(await d.provider().reattachWorkspaceNetwork("ws_live" as WorkspaceId)).toEqual({
      problem: "workspace is attached to a legacy or mismatched network",
    });
  });

  it("joins the proxy without the pin when the daemon refuses it, and says the pin is stale", async () => {
    const d = new FakeDaemon();
    workspace(d, "ws_live");
    const own = networkName("ws_live" as WorkspaceId);
    const proxy = d.containers.get("ws_live-proxy");
    const pinned = proxy?.Networks[own]?.IPAddress ?? "";
    if (proxy) delete proxy.Networks[own];
    d.refusedAddresses.add(pinned);
    expect(await d.provider().reattachWorkspaceNetwork("ws_live" as WorkspaceId)).toEqual({
      problem: "workspace egress-proxy address is missing or stale",
    });
    expect(proxy?.Networks[own]?.Aliases).toEqual(["egress-proxy"]);
  });

  it("is not_found for a workspace without a container", async () => {
    const error = await new FakeDaemon()
      .provider()
      .reattachWorkspaceNetwork("ws_none" as WorkspaceId)
      .catch((e: unknown) => e);
    expect(isDeskmatesError(error) && error.code).toBe("not_found");
  });
});
