// T0: ADR-0006 amendment 5. Decision 12: each finding comes from exactly its condition, in a
// stable order. Decision 14: pool headroom counts occupied chunks against the pools' capacity.

import { describe, expect, it } from "vitest";
import {
  DOCKER_DEFAULT_ADDRESS_POOLS,
  type HostResource,
  type KnownWorkspace,
  addressPoolHeadroom,
  classifyHostResources,
  poolStatus,
} from "./host-resources.js";

const container = (workspaceId: string, extra: Partial<HostResource> = {}): HostResource => ({
  kind: "container",
  name: `deskmates-ws-${workspaceId}`,
  id: `c-${workspaceId}`,
  workspaceId,
  role: "workspace",
  createdAt: "2026-10-16T10:00:00.000Z",
  sizeBytes: 100,
  ...extra,
});
const network = (workspaceId: string): HostResource => ({
  kind: "network",
  name: `deskmates-net-${workspaceId}`,
  id: `n-${workspaceId}`,
  workspaceId,
  role: "workspace",
  createdAt: "2026-10-16T09:00:00.000Z",
});
const volume = (workspaceId: string): HostResource => ({
  kind: "volume",
  name: `deskmates-${workspaceId}-work`,
  id: `deskmates-${workspaceId}-work`,
  workspaceId,
  role: "volume",
  sizeBytes: 900,
});

const KNOWN: Record<string, KnownWorkspace> = {
  ws_live: { name: "Ops", archived: false, liveRuns: 0 },
  ws_busy: { name: "Busy", archived: false, liveRuns: 1 },
  ws_old: { name: "Old", archived: true, liveRuns: 0 },
  ws_kept: { name: "Kept", archived: true, liveRuns: 0 },
};
const known = (id: string) => KNOWN[id];

describe("host resource classification (decision 12)", () => {
  it("leaves an active workspace whose topology is accepted unflagged", () => {
    const report = classifyHostResources(
      { resources: [container("ws_live"), network("ws_live"), volume("ws_live")] },
      known,
    );
    expect(report).toEqual({ findings: [], healthy: 3 });
  });

  it("flags an unknown workspace id as an orphan with Remove, size and age", () => {
    const { findings } = classifyHostResources(
      { resources: [container("ws_t2"), network("ws_t2"), volume("ws_t2")] },
      known,
    );
    expect(findings).toEqual([
      expect.objectContaining({
        id: "orphan:ws_t2",
        flag: "orphan",
        workspaceId: "ws_t2",
        action: "remove",
        sizeBytes: 1000,
        createdAt: "2026-10-16T09:00:00.000Z",
      }),
    ]);
    expect(findings[0]?.blocked).toBeUndefined();
    expect(findings[0]?.workspaceName).toBeUndefined();
  });

  it("blocks an orphan while a sidecar process runs in its container", () => {
    const { findings } = classifyHostResources(
      { resources: [container("ws_t2", { sidecarProcesses: 2 })] },
      known,
    );
    expect(findings[0]?.blocked).toMatch(/2 sidecar process/);
  });

  it("offers Remove for an archived workspace's runtime and nothing for its volumes alone", () => {
    const { findings } = classifyHostResources(
      { resources: [container("ws_old"), volume("ws_old"), volume("ws_kept")] },
      known,
    );
    expect(findings.map((f) => [f.id, f.action, f.workspaceName])).toEqual([
      ["archived:ws_kept", undefined, "Kept"],
      ["archived:ws_old", "remove", "Old"],
    ]);
    expect(findings[1]?.detail).toMatch(/keeps the volumes/);
  });

  it("offers Re-attach for a container the topology rule refuses, blocked while a run is live", () => {
    const problem = "workspace is attached to a legacy or mismatched network";
    const { findings, healthy } = classifyHostResources(
      {
        resources: [
          container("ws_live", { topologyProblem: problem }),
          network("ws_live"),
          container("ws_busy", { topologyProblem: problem }),
        ],
      },
      known,
    );
    expect(healthy).toBe(0);
    expect(findings.map((f) => [f.id, f.action, f.detail, f.blocked])).toEqual([
      ["topology_mismatch:ws_busy", "reattach", problem, expect.stringMatching(/1 run/)],
      ["topology_mismatch:ws_live", "reattach", problem, undefined],
    ]);
  });

  it("flags a former-name network apart from its workspace, blocked while containers are attached", () => {
    const legacy = (name: string, attachedContainers: number): HostResource => ({
      kind: "network",
      name,
      id: name,
      workspaceId: "ws_live",
      role: "legacy",
      attachedContainers,
    });
    const { findings, healthy } = classifyHostResources(
      {
        resources: [
          legacy("former-net-ws_live", 1),
          legacy("former-net-ws_gone", 0),
          container("ws_live"),
        ],
      },
      known,
    );
    expect(healthy).toBe(1);
    expect(findings.map((f) => [f.id, f.action, f.workspaceName, f.blocked])).toEqual([
      ["legacy_network:former-net-ws_gone", "remove", "Ops", undefined],
      ["legacy_network:former-net-ws_live", "remove", "Ops", expect.stringMatching(/attached/)],
    ]);
  });

  it("orders findings by flag, then id", () => {
    const { findings } = classifyHostResources(
      {
        resources: [
          { ...network("x"), name: "former-net-x", id: "l", role: "legacy" },
          container("ws_live", { topologyProblem: "workspace container labels changed" }),
          volume("ws_kept"),
          volume("ws_b"),
          volume("ws_a"),
        ],
      },
      known,
    );
    expect(findings.map((f) => f.id)).toEqual([
      "orphan:ws_a",
      "orphan:ws_b",
      "archived:ws_kept",
      "topology_mismatch:ws_live",
      "legacy_network:former-net-x",
    ]);
  });
});

describe("address pool headroom (decision 14)", () => {
  it("uses Docker's 31 default networks when the daemon reports no pools", () => {
    const headroom = addressPoolHeadroom(undefined, [
      { name: "bridge", cidr: "172.17.0.0/16" },
      { name: "deskmates-net-a", cidr: "172.18.0.0/16" },
      { name: "deskmates-net-b", cidr: "192.168.0.0/20" },
      { name: "deskmates-net-c", cidr: "192.168.16.0/20" },
      // Explicitly configured outside every pool: occupies no chunk.
      { name: "compose", cidr: "10.9.0.0/24" },
    ]);
    expect(headroom).toMatchObject({
      source: "docker_default",
      capacity: 31,
      inUse: 4,
      free: 27,
      status: "ok",
    });
    expect(headroom.pools).toEqual(DOCKER_DEFAULT_ADDRESS_POOLS);
  });

  it("reports the configured pools, low under a tenth and exhausted at none free", () => {
    const pools = [{ base: "10.200.0.0/16", size: 24 }];
    const subnets = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `n${i}`, cidr: `10.200.${i}.0/24` }));
    expect(addressPoolHeadroom(pools, subnets(10))).toMatchObject({
      source: "daemon",
      capacity: 256,
      inUse: 10,
      free: 246,
      status: "ok",
    });
    expect(addressPoolHeadroom(pools, subnets(232)).status).toBe("low");
    expect(addressPoolHeadroom(pools, subnets(256))).toMatchObject({
      free: 0,
      status: "exhausted",
    });
  });

  it("counts a wider subnet against every chunk it covers, and each chunk once", () => {
    const headroom = addressPoolHeadroom(
      [{ base: "10.200.0.0/16", size: 24 }],
      [
        { name: "wide", cidr: "10.200.0.0/22" },
        { name: "inside", cidr: "10.200.1.0/24" },
      ],
    );
    expect(headroom.inUse).toBe(4);
  });

  it("ignores a pool that does not parse and is unknown without capacity", () => {
    expect(addressPoolHeadroom([{ base: "nope", size: 24 }], []).status).toBe("unknown");
    expect(poolStatus(31, 3)).toBe("low");
    expect(poolStatus(31, 4)).toBe("ok");
  });
});
