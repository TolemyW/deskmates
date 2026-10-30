// T2: ADR-0006 amendment 5 against a real Docker daemon, using alpine so the run stays fast.
// Decision 11: what the provider lists. Decision 13: an orphan's Remove leaves nothing labelled
// with its id; a workspace moved to a wrong network by hand is repaired by Re-attach and attaches
// again. Skips with a message when the daemon is unreachable (colima stopped, no Docker).

import { randomUUID } from "node:crypto";
import type { WorkspaceId } from "@deskmates/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_EGRESS_PROXY_IMAGE,
  DockerProvider,
  MANAGED_LABEL,
  WORKSPACE_LABEL,
  containerName,
  networkName,
} from "./docker-provider.js";
import { requireEgressImage } from "./testing/image-preflight.js";

const IMAGE = "alpine:3.20";
const ALPINE_COMMAND = ["sh", "-c", "trap 'exit 0' TERM; sleep infinity & wait"];
const EGRESS_IMAGE = process.env.EGRESS_PROXY_IMAGE?.trim() || DEFAULT_EGRESS_PROXY_IMAGE;

const provider = new DockerProvider({
  containerCommand: ALPINE_COMMAND,
  egressProxyImage: EGRESS_IMAGE,
});

async function dockerReachable(p: DockerProvider): Promise<boolean> {
  try {
    const res = await p.client.request("GET", "/_ping", undefined, { timeoutMs: 3000 });
    return res.status === 200;
  } catch {
    return false;
  }
}

const available = await dockerReachable(provider);
if (!available)
  console.warn("[host-resources.container.test] Docker daemon unreachable; skipping T2 tests.");

/** Everything labelled with this workspace id that the daemon still has, by kind. */
async function labelled(workspaceId: string): Promise<string[]> {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`${WORKSPACE_LABEL}=${workspaceId}`, `${MANAGED_LABEL}=true`] }),
  );
  const containers = await provider.client.expect<{ Names: string[] }[]>(
    "GET",
    `/containers/json?all=true&filters=${filters}`,
  );
  const networks = await provider.client.expect<{ Name: string }[]>(
    "GET",
    `/networks?filters=${filters}`,
  );
  const volumes = await provider.client.expect<{ Volumes: { Name: string }[] | null }>(
    "GET",
    `/volumes?filters=${filters}`,
  );
  return [
    ...containers.json.map((c) => `container:${(c.Names[0] ?? "").replace(/^\//, "")}`),
    ...networks.json.map((n) => `network:${n.Name}`),
    ...(volumes.json.Volumes ?? []).map((v) => `volume:${v.Name}`),
  ].sort();
}

describe.skipIf(!available)("host resources (T2, real Docker, alpine)", () => {
  const suffix = randomUUID().slice(0, 8);
  const orphan = `t2-orphan-${suffix}` as WorkspaceId;
  const moved = `t2-moved-${suffix}` as WorkspaceId;
  const wrongNetwork = `deskmates-t2-wrong-${suffix}`;

  beforeAll(async () => {
    await requireEgressImage(provider, EGRESS_IMAGE);
    const local = await provider.client.request("GET", `/images/${IMAGE}/json`);
    if (local.status !== 200) {
      const res = await provider.client.request("POST", "/images/create?fromImage=alpine&tag=3.20");
      expect(res.status).toBe(200);
    }
    for (const workspaceId of [orphan, moved])
      await provider.create({
        workspaceId,
        image: IMAGE,
        env: {},
        volumes: { "/work": `deskmates-${workspaceId}-work` },
        ports: [],
        egressAllowlist: [],
      });
  }, 180_000);

  afterAll(async () => {
    for (const workspaceId of [orphan, moved])
      await provider.permanentlyDelete(workspaceId).catch(() => undefined);
    await provider.client.request("DELETE", `/networks/${wrongNetwork}`).catch(() => undefined);
  }, 120_000);

  it("lists both workspaces with their topology accepted and the daemon's pools", async () => {
    const inventory = await provider.listHostResources();
    const mine = inventory.resources.filter((r) => r.workspaceId === orphan);
    expect(mine.map((r) => `${r.kind}:${r.role}`).sort()).toEqual([
      "container:egress-proxy",
      "container:workspace",
      "network:workspace",
      "volume:volume",
    ]);
    expect(mine.find((r) => r.role === "workspace" && r.kind === "container")).toMatchObject({
      name: containerName(orphan),
      state: "running",
      sidecarProcesses: 0,
    });
    expect(mine.find((r) => r.kind === "container")?.topologyProblem).toBeUndefined();
    expect(inventory.subnets.some((s) => s.name === networkName(orphan))).toBe(true);
  });

  it("Remove leaves nothing labelled with the orphan's id", async () => {
    const removed = await provider.removeHostResources({
      kind: "workspace",
      workspaceId: orphan,
      keepVolumes: false,
    });
    expect(removed.map((r) => r.kind)).toEqual(["container", "container", "network", "volume"]);
    expect(await labelled(orphan)).toEqual([]);
    // The other workspace is untouched.
    expect(await labelled(moved)).toHaveLength(4);
  }, 60_000);

  it("Re-attach repairs a container moved to a wrong network by hand, and attach accepts it", async () => {
    const created = await provider.client.request("POST", "/networks/create", {
      Name: wrongNetwork,
      Internal: true,
    });
    expect(created.status).toBe(201);
    const container = containerName(moved);
    for (const [network, op] of [
      [networkName(moved), "disconnect"],
      [wrongNetwork, "connect"],
    ] as const) {
      const res = await provider.client.request("POST", `/networks/${network}/${op}`, {
        Container: container,
      });
      expect(res.status, `${op} ${network}`).toBe(200);
    }
    const before = await provider.listHostResources();
    expect(
      before.resources.find((r) => r.workspaceId === moved && r.role === "workspace")
        ?.topologyProblem,
    ).toBe("workspace is attached to a legacy or mismatched network");

    expect(await provider.reattachWorkspaceNetwork(moved)).toEqual({});
    const handle = await provider.attach(moved);
    expect(handle).toBeDefined();
    if (handle) await expect(provider.verifyTopology(handle)).resolves.toBeUndefined();
  }, 120_000);
});
