// T0: ADR-0027 amendment 2 in the Docker provider. Decision 15: the daemon's IPv4 subnets, read
// from `/networks` only. Decision 16: a cached handle's workspace container is held to attach's
// topology rules (own network only, no direct host alias, its labels); Engine API stubbed.

import { type SandboxHandle, type WorkspaceId, isDeskmatesError } from "@deskmates/contracts";
import { describe, expect, it } from "vitest";
import type { DockerClient } from "./docker-client.js";
import {
  DockerProvider,
  MANAGED_LABEL,
  ROLE_LABEL,
  WORKSPACE_LABEL,
  networkName,
} from "./docker-provider.js";
import { formerNameNetwork, networkSubnetsOf, topologyProblem } from "./network-topology.js";

const WS = "ws1" as WorkspaceId;
const handle = { workspaceId: WS, providerRef: "c1" } as SandboxHandle;
const own = networkName(WS);

function provider(answer: (method: string, path: string) => { status: number; json: unknown }) {
  const p = new DockerProvider({ endpoint: { kind: "unix", socketPath: "/nonexistent.sock" } });
  const calls: string[] = [];
  const patch = {
    expect: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      return answer(method, path);
    },
    request: async (method: string, path: string) => {
      calls.push(`${method} ${path}`);
      const { status, json } = answer(method, path);
      return { status, body: JSON.stringify(json) };
    },
  };
  Object.assign(p.client, patch as unknown as Partial<DockerClient>);
  return { p, calls };
}

function container(overrides: { networks?: string[]; extraHosts?: string[]; mode?: string } = {}) {
  const networks = overrides.networks ?? [own];
  return {
    Id: "c1",
    Config: {
      Labels: { [WORKSPACE_LABEL]: WS, [MANAGED_LABEL]: "true", [ROLE_LABEL]: "workspace" },
    },
    HostConfig: { ExtraHosts: overrides.extraHosts ?? [], NetworkMode: overrides.mode ?? own },
    NetworkSettings: { Networks: Object.fromEntries(networks.map((n) => [n, {}])) },
  };
}

describe("daemon subnets (decision 15)", () => {
  it("lists every IPv4 subnet by network name and skips IPv6 and empty configs", async () => {
    const { p, calls } = provider(() => ({
      status: 200,
      json: [
        { Name: "deskmates-egress-outbound", IPAM: { Config: [{ Subnet: "172.29.0.0/16" }] } },
        {
          Name: "bridge",
          IPAM: { Config: [{ Subnet: "172.17.0.0/16" }, { Subnet: "fd00::/64" }] },
        },
        { Name: "host", IPAM: { Config: [] } },
        { Name: "none", IPAM: null },
      ],
    }));
    expect(await p.networkSubnets()).toEqual([
      { name: "bridge", cidr: "172.17.0.0/16" },
      { name: "deskmates-egress-outbound", cidr: "172.29.0.0/16" },
    ]);
    expect(calls).toEqual(["GET /networks"]);
    expect(networkSubnetsOf([])).toEqual([]);
  });
});

describe("cached handle topology (decision 16)", () => {
  it("accepts the container attach would accept, reading only", async () => {
    const { p, calls } = provider(() => ({ status: 200, json: container() }));
    await expect(p.verifyTopology(handle)).resolves.toBeUndefined();
    expect(calls).toEqual(["GET /containers/c1/json"]);
  });

  it.each([
    ["an extra network added by hand", container({ networks: [own, "vendordb-demo-net"] })],
    [
      "its own network swapped",
      container({ networks: ["vendordb-demo-net"], mode: "vendordb-demo-net" }),
    ],
    ["a direct host alias", container({ extraHosts: ["host.docker.internal:172.17.0.1"] })],
    [
      "another workspace's labels",
      { ...container(), Config: { Labels: { [WORKSPACE_LABEL]: "ws2", [MANAGED_LABEL]: "true" } } },
    ],
  ])("refuses %s with attach's network error", async (_name, inspect) => {
    const { p } = provider(() => ({ status: 200, json: inspect }));
    const error = await p.verifyTopology(handle).catch((e: unknown) => e);
    expect(isDeskmatesError(error) && error.details).toMatchObject({ reason: "network_mismatch" });
  });

  it("refuses a container that is gone", async () => {
    const { p } = provider(() => ({ status: 404, json: { message: "no such container" } }));
    await expect(p.verifyTopology(handle)).rejects.toThrow("workspace container is gone");
  });
});

describe("topology flags (ADR-0006 amendment 5 decision 12)", () => {
  const expected = {
    labels: { [WORKSPACE_LABEL]: WS, [MANAGED_LABEL]: "true", [ROLE_LABEL]: "workspace" },
    network: own,
    hostAlias: "host.docker.internal",
  };

  it("accepts exactly attach's topology", () => {
    expect(topologyProblem(container(), expected)).toBeUndefined();
  });

  it.each([
    [
      "a missing role label",
      { ...container(), Config: { Labels: { [WORKSPACE_LABEL]: WS, [MANAGED_LABEL]: "true" } } },
      "workspace container labels changed",
    ],
    [
      "a direct host alias, in any case",
      container({ extraHosts: ["HOST.DOCKER.INTERNAL:172.17.0.1"] }),
      "workspace has a direct host alias",
    ],
    [
      "no network at all",
      container({ networks: [] }),
      "workspace is attached to a legacy or mismatched network",
    ],
    [
      "a second network",
      container({ networks: [own, "deskmates-net-ws2"] }),
      "workspace is attached to a legacy or mismatched network",
    ],
    [
      "a former-name network instead of its own",
      container({ networks: ["former-net-ws1"], mode: "former-net-ws1" }),
      "workspace is attached to a legacy or mismatched network",
    ],
    [
      "its own network with another network mode",
      container({ mode: "former-net-ws1" }),
      "workspace is attached to a legacy or mismatched network",
    ],
  ])("flags %s", (_name, inspect, problem) => {
    expect(topologyProblem(inspect, expected)).toBe(problem);
  });

  it("finds former-name networks by the provider's rule under another prefix, never its own", () => {
    const hex = `ws_${"0f".repeat(16)}`;
    const cases: Array<[string, Record<string, string>, unknown]> = [
      [
        "former-net-ws_1",
        { "former.managed": "true", "former.workspace": "ws_1" },
        { prefix: "former", workspaceId: "ws_1" },
      ],
      [`former-net-${hex}`, {}, { prefix: "former", workspaceId: hex }],
      ["former-egress-outbound", { "former.managed": "true" }, { prefix: "former" }],
      ["former-egress-outbound", {}, undefined],
      ["former-net-ws_1", { "former.managed": "true" }, undefined],
      ["former-net-misc", {}, undefined],
      ["deskmates-net-ws_1", { [MANAGED_LABEL]: "true", [WORKSPACE_LABEL]: "ws_1" }, undefined],
      [`deskmates-net-${hex}`, {}, undefined],
      ["deskmates-egress-outbound", { [MANAGED_LABEL]: "true" }, undefined],
      ["Former-net-ws_1", { "Former.managed": "true", "Former.workspace": "ws_1" }, undefined],
      ["bridge", {}, undefined],
    ];
    for (const [name, labels, want] of cases)
      expect(formerNameNetwork({ Name: name, Labels: labels }, "deskmates"), name).toEqual(want);
  });
});
