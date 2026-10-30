// Host resources (ADR-0006 amendment 5, issue #14): what the sandbox provider owns on its host,
// classified against the Gateway's workspaces. The provider lists (decision 11), the Gateway
// classifies (decision 12) with the pure functions here, and the root acts on one finding at a
// time (decision 13). Pool headroom (decision 14) is plain arithmetic over CIDRs.

import { type SandboxNetworkSubnet, parseIpv4Cidr } from "./network-overlap.js";

export type HostResourceKind = "container" | "network" | "volume";

/** One container, network or volume on the provider's host. */
export interface HostResource {
  kind: HostResourceKind;
  /** The provider's name for it (a container's without the leading slash). */
  name: string;
  /** The provider's id; a volume's is its name. */
  id: string;
  /** The workspace its ownership label (or a former-name network's label) names; absent: none. */
  workspaceId?: string;
  /**
   * What it is for the workspace: a container's `workspace` or `egress-proxy`, a network's
   * `workspace` or `legacy` (a former product name's), a volume's `volume`.
   */
  role?: string;
  /** When the provider created it. */
  createdAt?: string;
  /** Bytes on disk where the provider reports them (a container's writable layer, a volume). */
  sizeBytes?: number;
  /** A container's state (`running`, `exited`, ...). */
  state?: string;
  /** A workspace container only: why `attach` would refuse its topology; absent when accepted. */
  topologyProblem?: string;
  /** A running workspace container only: sidecar processes in it right now (some Gateway's run). */
  sidecarProcesses?: number;
  /** A network only: containers attached to it right now. */
  attachedContainers?: number;
}

/** One of the daemon's default address pools: `base` cut into networks of prefix `size`. */
export interface AddressPool {
  base: string;
  size: number;
}

/**
 * Docker's documented local-scope defaults when `default-address-pools` is unset: fifteen /16 in
 * 172.17-172.31 and 192.168.0.0/16 cut into /20, 31 networks in all, the default bridge included.
 */
export const DOCKER_DEFAULT_ADDRESS_POOLS: readonly AddressPool[] = [
  ...Array.from({ length: 15 }, (_, i) => ({ base: `172.${17 + i}.0.0/16`, size: 16 })),
  { base: "192.168.0.0/16", size: 20 },
];

/** What `SandboxProvider.listHostResources` returns: facts only, nothing classified yet. */
export interface HostResourceInventory {
  resources: HostResource[];
  /** The daemon's configured pools; absent when it reports none (Docker's defaults apply). */
  addressPools?: AddressPool[];
  /** The IPv4 subnets of every network on the daemon. */
  subnets: SandboxNetworkSubnet[];
}

export type AddressPoolStatus = "ok" | "low" | "exhausted" | "unknown";

export interface AddressPoolHeadroom {
  status: AddressPoolStatus;
  /** `daemon`: the configured pools; `docker_default`: none configured, Docker's defaults. */
  source: "daemon" | "docker_default";
  pools: AddressPool[];
  /** Networks the pools can hold. */
  capacity: number;
  /** Pool chunks an existing network's subnet occupies. */
  inUse: number;
  free: number;
}

export type HostResourceFlag =
  /** The workspace id is not in `workspaces` (a T2 leftover, a purged row, another Gateway). */
  | "orphan"
  /** The workspace is archived and resources of it are still on the host. */
  | "archived"
  /** A workspace container that the topology rule of `attach` refuses. */
  | "topology_mismatch"
  /** A workspace network of a former product name. */
  | "legacy_network";

export type HostResourceAction = "remove" | "reattach";

export interface HostResourceFinding {
  /** `<flag>:<workspace id or network name>`; stable across reports of the same host state. */
  id: string;
  flag: HostResourceFlag;
  workspaceId?: string;
  /** The workspace's name when the Gateway knows it. */
  workspaceName?: string;
  resources: HostResource[];
  /** The sum of the sizes the provider reported; absent when it reported none. */
  sizeBytes?: number;
  /** The oldest resource's creation time. */
  createdAt?: string;
  /** Why it was flagged, one English sentence. */
  detail: string;
  /** The one action that applies; absent when there is nothing to do. */
  action?: HostResourceAction;
  /** Why the action is refused right now (a live run); absent when it may run. */
  blocked?: string;
}

/** `GET /api/runtime/resources`. */
export interface HostResourceReport {
  /** False when the provider cannot list its host; nothing was classified then. */
  checked: boolean;
  checkedAt: string;
  findings: HostResourceFinding[];
  /** Resources of active workspaces with nothing wrong, counted but not listed. */
  healthy: number;
  pool?: AddressPoolHeadroom;
  error?: string;
}

/** What a provider removes for one finding (decision 13). */
export type HostResourceTarget =
  | {
      kind: "workspace";
      workspaceId: string;
      /** An archived workspace keeps its volumes for a restore; a purge deletes them. */
      keepVolumes: boolean;
    }
  | { kind: "network"; name: string };

/** `POST /api/runtime/resources/remove` and `.../reattach`. */
export interface HostResourceActionResult {
  findingId: string;
  action: HostResourceAction;
  /** Remove: what the provider deleted, in order. */
  removed?: HostResource[];
  /** Re-attach: whether the topology is accepted now. */
  repaired?: boolean;
  /** Re-attach: what is still wrong when not repaired. */
  problem?: string;
  report: HostResourceReport;
}

/** A pool's chunks: networks of prefix `size` inside `base`; undefined when it does not parse. */
function chunksOf(pool: AddressPool): { base: number; prefix: number; count: number } | undefined {
  const parsed = parseIpv4Cidr(pool.base);
  if (!parsed || !Number.isInteger(pool.size) || pool.size < parsed.prefix || pool.size > 32)
    return undefined;
  return { ...parsed, count: 2 ** (pool.size - parsed.prefix) };
}

/**
 * Decision 14: how many networks the pools hold and how many of their chunks the daemon's
 * subnets occupy. A subnet counts against every chunk it overlaps; one outside every pool (an
 * explicitly configured subnet) counts against none.
 */
export function addressPoolHeadroom(
  configured: readonly AddressPool[] | undefined,
  subnets: readonly SandboxNetworkSubnet[],
): AddressPoolHeadroom {
  const source = configured && configured.length > 0 ? "daemon" : "docker_default";
  const pools = [...(source === "daemon" ? (configured ?? []) : DOCKER_DEFAULT_ADDRESS_POOLS)];
  let capacity = 0;
  let inUse = 0;
  for (const pool of pools) {
    const chunks = chunksOf(pool);
    if (!chunks) continue;
    capacity += chunks.count;
    const chunkSize = 2 ** (32 - pool.size);
    const poolEnd = chunks.base + chunks.count * chunkSize - 1;
    const used = new Set<number>();
    for (const subnet of subnets) {
      const s = parseIpv4Cidr(subnet.cidr);
      if (!s) continue;
      const start = s.base;
      const end = s.base + 2 ** (32 - s.prefix) - 1;
      if (end < chunks.base || start > poolEnd) continue;
      const first = Math.floor((Math.max(start, chunks.base) - chunks.base) / chunkSize);
      const last = Math.floor((Math.min(end, poolEnd) - chunks.base) / chunkSize);
      for (let i = first; i <= last; i += 1) used.add(i);
    }
    inUse += used.size;
  }
  const free = Math.max(0, capacity - inUse);
  return { status: poolStatus(capacity, free), source, pools, capacity, inUse, free };
}

/** Exhausted at none free; low under a tenth of the capacity; unknown without any pool. */
export function poolStatus(capacity: number, free: number): AddressPoolStatus {
  if (capacity <= 0) return "unknown";
  if (free === 0) return "exhausted";
  return free < Math.ceil(capacity / 10) ? "low" : "ok";
}

/** What the Gateway knows about one workspace id. */
export interface KnownWorkspace {
  name: string;
  archived: boolean;
  /** Runs of this Gateway executing in the workspace now. */
  liveRuns: number;
}

function sum(resources: readonly HostResource[]): number | undefined {
  const sizes = resources.flatMap((r) => (r.sizeBytes === undefined ? [] : [r.sizeBytes]));
  return sizes.length === 0 ? undefined : sizes.reduce((a, b) => a + b, 0);
}

function oldest(resources: readonly HostResource[]): string | undefined {
  return resources
    .flatMap((r) => (r.createdAt === undefined ? [] : [r.createdAt]))
    .sort()
    .at(0);
}

function liveBlock(known: KnownWorkspace | undefined, resources: readonly HostResource[]) {
  if (known && known.liveRuns > 0)
    return `${known.liveRuns} run(s) of this Gateway are live in the workspace`;
  const processes = resources.reduce((n, r) => n + (r.sidecarProcesses ?? 0), 0);
  if (processes > 0) return `${processes} sidecar process(es) are running in the container`;
  return undefined;
}

function finding(
  flag: HostResourceFlag,
  key: string,
  resources: HostResource[],
  detail: string,
  extra: Partial<HostResourceFinding>,
): HostResourceFinding {
  const size = sum(resources);
  const created = oldest(resources);
  return {
    id: `${flag}:${key}`,
    flag,
    resources,
    ...(size === undefined ? {} : { sizeBytes: size }),
    ...(created === undefined ? {} : { createdAt: created }),
    detail,
    ...extra,
  };
}

/**
 * Decision 12: findings in a stable order (flag, then key), and the number of healthy resources.
 * Resources of an active workspace are healthy unless its container fails the topology rule.
 */
export function classifyHostResources(
  inventory: Pick<HostResourceInventory, "resources">,
  known: (workspaceId: string) => KnownWorkspace | undefined,
): { findings: HostResourceFinding[]; healthy: number } {
  const findings: HostResourceFinding[] = [];
  let healthy = 0;
  const byWorkspace = new Map<string, HostResource[]>();
  for (const resource of inventory.resources) {
    if (resource.role === "legacy") {
      const blocked =
        (resource.attachedContainers ?? 0) > 0
          ? `${resource.attachedContainers} container(s) are attached; re-attach a workspace container first`
          : undefined;
      const ws = resource.workspaceId === undefined ? undefined : known(resource.workspaceId);
      findings.push(
        finding(
          "legacy_network",
          resource.name,
          [resource],
          "a workspace network of a former product name",
          {
            ...(resource.workspaceId === undefined ? {} : { workspaceId: resource.workspaceId }),
            ...(ws ? { workspaceName: ws.name } : {}),
            action: "remove",
            ...(blocked ? { blocked } : {}),
          },
        ),
      );
      continue;
    }
    if (resource.workspaceId === undefined) continue;
    const list = byWorkspace.get(resource.workspaceId) ?? [];
    list.push(resource);
    byWorkspace.set(resource.workspaceId, list);
  }
  for (const [workspaceId, resources] of byWorkspace) {
    const ws = known(workspaceId);
    const blocked = liveBlock(ws, resources);
    const common = {
      workspaceId,
      ...(ws ? { workspaceName: ws.name } : {}),
      ...(blocked ? { blocked } : {}),
    };
    if (ws === undefined) {
      findings.push(
        finding("orphan", workspaceId, resources, "no workspace with this id in the database", {
          ...common,
          action: "remove",
        }),
      );
      continue;
    }
    if (ws.archived) {
      const runtime = resources.some((r) => r.kind !== "volume");
      findings.push(
        finding(
          "archived",
          workspaceId,
          resources,
          runtime
            ? "the workspace is archived and its runtime is still on the host; Remove keeps the volumes for a restore"
            : "the workspace is archived; its volumes are kept for a restore and a purge from Trash deletes them",
          runtime ? { ...common, action: "remove" } : { ...common },
        ),
      );
      continue;
    }
    const mismatched = resources.find(
      (r) => r.kind === "container" && r.topologyProblem !== undefined,
    );
    if (mismatched) {
      findings.push(
        finding("topology_mismatch", workspaceId, resources, mismatched.topologyProblem ?? "", {
          ...common,
          action: "reattach",
        }),
      );
      continue;
    }
    healthy += resources.length;
  }
  const order: HostResourceFlag[] = ["orphan", "archived", "topology_mismatch", "legacy_network"];
  findings.sort(
    (a, b) => order.indexOf(a.flag) - order.indexOf(b.flag) || a.id.localeCompare(b.id),
  );
  return { findings, healthy };
}
