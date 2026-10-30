// The SandboxProvider interface. Implemented by @deskmates/sandbox-docker (M0) and a Desktop VM
// provider (M3). The Gateway talks to sandboxes only through this interface.

import type { HostResource, HostResourceInventory, HostResourceTarget } from "./host-resources.js";
import type { WorkspaceId } from "./ids.js";
import type { SandboxNetworkSubnet } from "./network-overlap.js";
import type { EgressProbeRequest, EgressProbeResult, NetworkGrant } from "./network-profile.js";

/**
 * The name a Docker workspace uses to reach the Gateway on its host. Docker Desktop and colima
 * resolve it natively; on a plain Linux daemon the provider adds it as `host-gateway`. The
 * Gateway falls back to it when it listens on every interface and `GATEWAY_BASE_URL` is unset.
 */
export const DOCKER_HOST_ALIAS = "host.docker.internal";

/**
 * The port noVNC listens on inside the workspace image. The Gateway lists it in `SandboxSpec.ports`
 * so the provider publishes it on the host's loopback and reports the address as
 * `SandboxHandle.novncAddress`, which only the Gateway's screen proxy connects to; the takeover
 * UI streams through that proxy and never sees the address or password (ADR-0022 amendment 1).
 */
export const NOVNC_CONTAINER_PORT = 6080;

export interface SandboxSpec {
  workspaceId: WorkspaceId;
  /**
   * The tenant that owns the workspace (ADR-0022 DOCKER-01). A provider labels what it creates
   * with it and refuses to attach to a sandbox labelled for another tenant.
   */
  tenantId?: string;
  image: string;
  /** Operator-maintained external network policy; empty denies all external egress. */
  egressAllowlist: readonly string[];
  /** Root-selected LAN grants of the workspace's network profiles (ADR-0027 amendment 1). */
  egressGrants?: readonly NetworkGrant[];
  /** Environment set at container creation. Model credentials are NOT here; see `injectEnv`. */
  env: Readonly<Record<string, string>>;
  /** Named volumes to mount: `/profile` (browser), `/work`, `/home`. */
  volumes: Readonly<Record<string, string>>;
  /** Container ports to publish on the host, e.g. noVNC. */
  ports: readonly number[];
  memoryLimitBytes?: number;
  /** CPU cores the container may use together, fractions allowed; omitted means no limit. */
  cpuLimit?: number;
}

export interface SandboxHandle {
  workspaceId: WorkspaceId;
  /** Provider-specific id (container id, VM name). */
  providerRef: string;
  /** Address the Gateway uses to reach the sidecar supervisor inside the sandbox. */
  sidecarAddress: string;
  /** Host loopback address of noVNC, if published; only the Gateway's screen proxy uses it. */
  novncAddress?: string;
  /**
   * In-memory takeover credential, never persisted in the Gateway database or events, and never
   * sent to a browser: the screen proxy authenticates with it (ADR-0022 amendment 1).
   */
  novncPassword?: string;
  /** Server-enforced view-only credential; same handling rules as the control credential. */
  novncViewPassword?: string;
  /** Fixed desktop-region addresses on a shared-monitors-v1 workspace, never CDP endpoints. */
  botScreenAddresses?: readonly string[];
  /**
   * Host loopback address of the egress proxy's app relay (ADR-0035 decision 4); only the
   * Gateway's app ingress uses it, and only for a published port.
   */
  appRelayAddress?: string;
  /** The relay's per-proxy key. Gateway memory only, like the VNC passwords. */
  appRelayKey?: string;
}

/**
 * Env var the scheduler sets on every sidecar exec: the run it belongs to. A new Gateway finds and
 * kills an old process of a live run by it (`SandboxProvider.killRun`, ADR-0029 decision 4).
 */
export const RUN_MARKER_ENV = "DESKMATES_RUN_ID";

export interface ExecRequest {
  cmd: readonly string[];
  env?: Readonly<Record<string, string>>;
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  /**
   * Aborting ends the exec the way a passed deadline does: the provider kills the process tree
   * and the result reports `timedOut` with exit -1. The scheduler uses it for a cancelled run
   * whose sidecar did not stop inside the grace window.
   */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxSnapshot {
  takenAt: string;
  /** Provider-specific reference to the snapshot artifact. */
  ref: string;
}

/**
 * One part of a sandbox that runs an image other than the one it would be created from now,
 * e.g. after an upgrade changed `WORKSPACE_IMAGE` or `EGRESS_PROXY_IMAGE`.
 */
export interface SandboxImageDrift {
  /**
   * Which part drifted: `"workspace"` for the sandbox itself, or a provider-named piece of
   * infrastructure next to it (the Docker provider reports `"egress-proxy"`).
   */
  component: string;
  /** Provider content ID of the image the part runs (Docker: `sha256:…`). */
  runningImageId: string;
  /** Provider content ID the configured image reference resolves to now. */
  configuredImageId: string;
}

/** Metadata-only evidence; neither certificate contents nor an authorization to trust it. */
export interface SandboxVolatilePrerequisite {
  code: "volatile_nss_database";
  path: string;
  sourceProviderRef: string;
}

export interface SandboxRestorationRequirement extends SandboxVolatilePrerequisite {
  status: "at_risk" | "restoration_required" | "replacement_outcome_unknown";
}

export interface SandboxProvider {
  readonly kind: "docker" | "desktop-vm" | "fake";
  /** Read-only compatibility check. Reject before any existing runtime is stopped or removed. */
  preflight(spec: SandboxSpec): Promise<void>;
  /**
   * One connectivity preflight from the workspace's network position: DNS, TCP, TLS and HTTP
   * layers (ADR-0027 amendment 1 decision 14). Read-only; optional for providers without it.
   */
  probeEgress?(handle: SandboxHandle, request: EgressProbeRequest): Promise<EgressProbeResult>;
  /**
   * The IPv4 subnets of every network on the provider's daemon, for Docker/LAN overlap
   * detection (ADR-0027 amendment 2 decision 15). Read-only; optional.
   */
  networkSubnets?(): Promise<SandboxNetworkSubnet[]>;
  /**
   * Whether a cached handle's sandbox still has the topology `attach` would accept; throws the
   * same network error attach would (amendment 2 decision 16). Read-only; optional.
   */
  verifyTopology?(handle: SandboxHandle): Promise<void>;
  /**
   * Every resource the provider owns on its host, former-name workspace networks included, and
   * the daemon's address pools (ADR-0006 amendment 5 decision 11). Read-only; optional.
   */
  listHostResources?(): Promise<HostResourceInventory>;
  /**
   * Remove what one finding names (decision 13): a workspace's containers (the workspace, then
   * its proxy), its network and, unless kept, its volumes, in that order; or one former-name
   * network while nothing is attached. Ownership labels are checked again before each delete.
   * Returns what was removed. The caller has classified the target and checked for live runs.
   */
  removeHostResources?(target: HostResourceTarget): Promise<HostResource[]>;
  /**
   * Put a workspace's container and proxy back on the workspace's own network (decision 13):
   * disconnect every other network, create the own one if missing, connect both with their
   * aliases, inspect again. Resolves with the topology problem still left, if any.
   */
  reattachWorkspaceNetwork?(workspaceId: WorkspaceId): Promise<{ problem?: string }>;
  /** Read-only metadata inspection of temporary prerequisites that replacement may discard. */
  inspectVolatilePrerequisites?(
    spec: SandboxSpec,
    requiredProviderRef?: string,
  ): Promise<readonly SandboxVolatilePrerequisite[]>;
  /**
   * The labels of an image on the provider's daemon, read only, never a pull (ADR-0048
   * decision 11: the desktop capability). Optional; without it a capability reads as unknown.
   */
  imageLabels?(image: string): Promise<Readonly<Record<string, string>>>;
  create(spec: SandboxSpec): Promise<SandboxHandle>;
  /**
   * Re-attach to a sandbox that already exists, e.g. after a Gateway restart. With `tenantId`, a
   * sandbox whose ownership label names another tenant (or, outside the Default Tenant, names
   * none) is refused rather than attached (ADR-0022 DOCKER-01).
   */
  attach(workspaceId: WorkspaceId, tenantId?: string): Promise<SandboxHandle | undefined>;
  /**
   * Read-only existence check of one exact cached sandbox, stopped instances included. False
   * means confirmed absence; daemon, permission and transport failures reject. Never starts,
   * repairs or reattaches resources. Optional for providers without an independent inspector.
   */
  isPresent?(handle: SandboxHandle): Promise<boolean>;
  /**
   * Remove the workspace's sandbox when any part of it runs an image other than the one it would
   * be created from now: `image` for the sandbox itself, the provider's own configured images for
   * its infrastructure. Named volumes stay, so a following `create` gets the same profile, work
   * and home directories. Returns the drift it acted on; empty when the sandbox is current or
   * absent, in which case nothing was touched.
   *
   * Never acquires an image: when a configured image is not present the call fails with
   * `sandbox_unavailable` / `details.reason = "image_missing"` before anything is removed.
   * The caller guarantees that no run is using the sandbox.
   *
   * `beforeRemove` runs once drift is found and before anything is removed; if it rejects,
   * nothing is removed and the rejection propagates. It is never called for a current or
   * absent sandbox, so a plain reattach does not pay for a replacement preflight.
   */
  removeStaleSandbox(
    workspaceId: WorkspaceId,
    image: string,
    beforeRemove?: (drift: readonly SandboxImageDrift[]) => Promise<void>,
  ): Promise<readonly SandboxImageDrift[]>;
  exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult>;
  /**
   * Kill every process in the sandbox whose environment carries `RUN_MARKER_ENV=<runId>`: the
   * sidecar of a run whose Gateway is gone (ADR-0029 decision 4). Best effort and idempotent; no
   * such process is not an error.
   */
  killRun(handle: SandboxHandle, runId: string): Promise<void>;
  /**
   * Deliver per-run environment (short-lived model token) to the sandbox without restarting it.
   * The values never enter the create spec, so they are not visible via `docker inspect`.
   */
  injectEnv(handle: SandboxHandle, env: Readonly<Record<string, string>>): Promise<void>;
  /**
   * Replace network policy; reject on failure rather than leave a permissive fallback. `grants`
   * are the workspace's network-profile grants (ADR-0027 amendment 1). A provider may report
   * the acknowledged policy hash and whether the proxy had to reload.
   */
  updateEgress(
    handle: SandboxHandle,
    allowlist: readonly string[],
    grants?: readonly NetworkGrant[],
    // biome-ignore lint/suspicious/noConfusingVoidType: providers without acknowledgements return nothing
  ): Promise<EgressAcknowledgement | void>;
  snapshot(handle: SandboxHandle): Promise<SandboxSnapshot>;
  /** Stop and remove ephemeral runtime resources while preserving every named volume. */
  destroy(handle: SandboxHandle): Promise<void>;
  /** Remove every exact, managed resource for this workspace, named volumes included. */
  permanentlyDelete(workspaceId: WorkspaceId, tenantId?: string): Promise<void>;
}

/** What `updateEgress` acknowledged: the policy hash and whether the proxy reloaded. */
export interface EgressAcknowledgement {
  policyHash: string;
  reloaded: boolean;
}
