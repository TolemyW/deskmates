// DockerProvider: SandboxProvider backed by the Docker Engine API. One workspace = one container
// (ADR-0004): one Chromium, one profile, one filesystem, one shell, shared by every bot in it.
// Bots inside are not separated by anything here; isolation is a second container.

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  DeskmatesError,
  type EgressAcknowledgement,
  type EgressProbeRequest,
  type EgressProbeResult,
  type ExecRequest,
  type ExecResult,
  type HostResource,
  type HostResourceInventory,
  type HostResourceTarget,
  NOVNC_CONTAINER_PORT,
  type NetworkGrant,
  type PrivateEgressTarget,
  RUN_MARKER_ENV,
  type SandboxHandle,
  type SandboxImageDrift,
  type SandboxNetworkSubnet,
  type SandboxProvider,
  type SandboxSnapshot,
  type SandboxSpec,
  type SandboxVolatilePrerequisite,
  type WorkspaceId,
  isEgressPattern,
  parsePrivateEgressTargets,
} from "@deskmates/contracts";
import { DockerClient, dockerApiError } from "./docker-client.js";
import { type DockerEndpoint, resolveDockerEndpoint } from "./docker-endpoint.js";
import { DockerStreamDemuxer } from "./docker-stream.js";
import { ENV_FILE_PATH, renderEnvFile } from "./env-file.js";
import {
  type NetworkSummary,
  formerNameNetwork,
  networkSubnetsOf,
  topologyProblem,
} from "./network-topology.js";

/**
 * The prefix of every name and label below. A former product name used the same rule under its
 * own prefix; `formerNameNetwork` finds what it left behind (ADR-0006 amendment 5).
 */
export const RESOURCE_PREFIX = "deskmates";
/** Label that ties a container to its workspace so `attach` can find it after a Gateway restart. */
export const WORKSPACE_LABEL = "deskmates.workspace";
/** Label that marks a container as ours; `attach` refuses anything without it. */
export const MANAGED_LABEL = "deskmates.managed";
/** Owning tenant (ADR-0022 DOCKER-01); absent only on sandboxes created before tenants. */
export const TENANT_LABEL = "deskmates.tenant";
/** The tenant pre-tenant sandboxes were migrated into; only it may attach an unlabelled one. */
const LEGACY_TENANT = "tnt_default";

function tenantLabels(tenantId: string | undefined): Record<string, string> {
  return tenantId === undefined ? {} : { [TENANT_LABEL]: tenantId };
}
/** Distinguishes the infrastructure-only egress proxy from a workspace container. */
export const ROLE_LABEL = "deskmates.role";
export const EGRESS_PROXY_ROLE = "egress-proxy";
export const EGRESS_PROXY_PORT = 3128;
export const DEFAULT_EGRESS_PROXY_IMAGE = "deskmates/egress-proxy:dev";
export const EGRESS_OUTBOUND_NETWORK = "deskmates-egress-outbound";
export const DEFAULT_HOST_TARGET = "host.docker.internal";
export const VNC_PASSWORD_ENV = "DESKMATES_VNC_PASSWORD";
/** The egress proxy's app relay (ADR-0035 decision 4): container port and key variable. */
export const APP_RELAY_PORT = 6090;
export const APP_RELAY_KEY_ENV = "DESKMATES_APP_RELAY_KEY";
/**
 * noVNC listens here inside the workspace image; published when the spec lists it. The number
 * belongs to contracts, where the Gateway reads it to build the spec; re-exported here so
 * importers of this package keep working.
 */
export { NOVNC_CONTAINER_PORT };
/** Env var carried by every exec so a timed-out process tree can be found and killed. */
const EXEC_MARKER_ENV = "DESKMATES_EXEC_ID";
/** How long `create`/`attach` wait for the image's HEALTHCHECK to report healthy. */
export const DEFAULT_READY_TIMEOUT_MS = 90_000;
/** Gap between health inspections while waiting. */
const READY_POLL_MS = 500;

export interface DockerProviderOptions {
  /** Defaults to DOCKER_HOST, then the docker CLI's current context, then /var/run/docker.sock. */
  endpoint?: DockerEndpoint;
  /** Chromium needs a large /dev/shm; S0 test-c ran with 1 GiB. */
  shmSizeBytes?: number;
  /** Where injectEnv writes; its parent directory is mounted as tmpfs. */
  envFilePath?: string;
  /** Host interface published ports bind to. Loopback: only the Gateway on this host reaches them. */
  publishHost?: string;
  /** Extra /etc/hosts entries. Default makes host.docker.internal work on a plain Linux daemon. */
  extraHosts?: readonly string[];
  /**
   * Override the image's CMD. The workspace image has an entrypoint and needs none; tests that
   * run a bare image (alpine) pass `["sleep", "infinity"]` so the container stays up.
   */
  containerCommand?: readonly string[];
  /**
   * How long `create` and `attach` wait for a container whose image declares a HEALTHCHECK to
   * report `healthy`. The workspace image needs seconds for Xvfb and Chromium; returning before
   * that races the first run's MCP attach. Images with no health check are not waited for.
   */
  readyTimeoutMs?: number;
  /** Infrastructure image with the allowlist-enforcing HTTP(S) forward proxy. */
  egressProxyImage?: string;
  /** Operator-selected infrastructure host address, fixed in the proxy at process startup. */
  hostTarget?: string;
  /**
   * DNS servers (IP addresses) for the egress proxy container only, from the Gateway's
   * `EGRESS_PROXY_DNS` (ADR-0010). Undefined keeps Docker's embedded resolver. The workspace
   * container never gets a resolver of its own.
   */
  egressProxyDns?: readonly string[];
  /**
   * JSON DNS-over-HTTPS endpoint (https, IP-literal host) from the Gateway's
   * `EGRESS_PROXY_DOH_URL` (ADR-0010 decision 4a), passed to the egress proxy container only as
   * `DESKMATES_DOH_URL`. Undefined keeps port-53 resolution.
   */
  egressProxyDohUrl?: string;
  privateEgressTargets?: readonly PrivateEgressTarget[];
}

/** Why `value` is not a usable DoH endpoint, or undefined when it is. */
function dohUrlProblem(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "is not a URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (url.username !== "" || url.password !== "") return "must not carry credentials";
  // A hostname would be resolved through the port-53 path DoH exists to avoid.
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0) return "host must be an IP literal";
  return undefined;
}

/** `State.Health` is present only when the image declares a HEALTHCHECK. */
interface ContainerHealth {
  Status: "starting" | "healthy" | "unhealthy" | (string & {});
  FailingStreak?: number;
}

interface ContainerInspect {
  Id: string;
  Name: string;
  State: { Running: boolean; Status: string; Health?: ContainerHealth };
  Config: { Env?: string[]; Labels?: Record<string, string> };
  HostConfig?: { ExtraHosts?: string[]; NetworkMode?: string };
  NetworkSettings: {
    Ports?: Record<string, { HostIp: string; HostPort: string }[] | null>;
    Networks?: Record<string, { IPAddress?: string; Gateway?: string; Aliases?: string[] }>;
  };
}

interface NetworkInspect {
  Id: string;
  Name: string;
  Internal: boolean;
  Labels?: Record<string, string>;
  IPAM?: { Config?: { Subnet?: string; Gateway?: string }[] };
  /** Attached endpoints, by container id; present on inspect only. */
  Containers?: Record<string, unknown> | null;
}

/** The `/networks` list shape. */
interface NetworkListEntry extends NetworkSummary {
  Id: string;
  Created?: string;
  Labels?: Record<string, string> | null;
}

/** The `/volumes` list shape. */
interface VolumeListEntry {
  Name: string;
  CreatedAt?: string;
  Labels?: Record<string, string> | null;
}

/** The part of `/info` the address-pool headroom reads. */
interface DaemonInfo {
  DefaultAddressPools?: { Base: string; Size: number }[] | null;
}

interface VolumeInspect {
  Name: string;
  Labels?: Record<string, string>;
}

/** The `/containers/json` list shape; a summary, not the full inspect. */
interface ContainerSummary {
  Id: string;
  Names?: string[];
  State: string;
  /** Unix seconds. */
  Created?: number;
  /** Bytes of the writable layer; only with `size=true`. */
  SizeRw?: number;
  /** Content ID (`sha256:…`) of the image the container was created from. */
  ImageID?: string;
  Labels?: Record<string, string>;
}

interface ExecInspect {
  Running: boolean;
  ExitCode: number | null;
}

export class DockerProvider implements SandboxProvider {
  readonly kind = "docker" as const;
  readonly client: DockerClient;
  private readonly shmSizeBytes: number;
  private readonly envFilePath: string;
  private readonly publishHost: string;
  private readonly extraHosts: readonly string[];
  private readonly containerCommand: readonly string[] | undefined;
  private readonly readyTimeoutMs: number;
  private readonly egressProxyImage: string;
  private readonly hostTarget: string;
  private readonly egressProxyDns: readonly string[] | undefined;
  private readonly egressProxyDohUrl: string | undefined;
  private readonly privateEgressTargets: PrivateEgressTarget[];

  constructor(opts: DockerProviderOptions = {}) {
    if (opts.egressProxyDns?.some((server) => isIP(server) === 0)) {
      throw new DeskmatesError("validation", "egress proxy DNS servers must be IP addresses");
    }
    this.egressProxyDns = opts.egressProxyDns ? [...opts.egressProxyDns] : undefined;
    if (opts.egressProxyDohUrl !== undefined) {
      const problem = dohUrlProblem(opts.egressProxyDohUrl);
      if (problem !== undefined) {
        throw new DeskmatesError("validation", `egress proxy DoH URL ${problem}`);
      }
    }
    this.egressProxyDohUrl = opts.egressProxyDohUrl;
    this.privateEgressTargets = parsePrivateEgressTargets(opts.privateEgressTargets ?? []);
    this.client = new DockerClient(opts.endpoint ?? resolveDockerEndpoint());
    this.shmSizeBytes = opts.shmSizeBytes ?? 1024 * 1024 * 1024;
    this.envFilePath = opts.envFilePath ?? ENV_FILE_PATH;
    this.publishHost = opts.publishHost ?? "127.0.0.1";
    this.extraHosts = opts.extraHosts ?? [];
    this.containerCommand = opts.containerCommand;
    this.readyTimeoutMs = opts.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    this.egressProxyImage = opts.egressProxyImage ?? DEFAULT_EGRESS_PROXY_IMAGE;
    this.hostTarget = (opts.hostTarget ?? DEFAULT_HOST_TARGET).toLowerCase();
    if (
      this.hostTarget.length > 253 ||
      (isIP(this.hostTarget) === 0 && !/^[a-zA-Z0-9.-]+$/.test(this.hostTarget)) ||
      this.extraHosts.some((entry) => entry.toLowerCase().startsWith(`${DEFAULT_HOST_TARGET}:`))
    ) {
      throw new DeskmatesError("validation", "invalid or conflicting infrastructure host target");
    }
  }

  /** Inspect only: in particular, never create/relabel a legacy volume by its name. */
  async preflight(spec: SandboxSpec): Promise<void> {
    validateVncPassword(spec);
    if (!Array.isArray(spec.egressAllowlist)) {
      throw new DeskmatesError("validation", "egressAllowlist is required");
    }
    canonicalAllowlist(spec.egressAllowlist);
    if (
      (spec.memoryLimitBytes !== undefined &&
        (!Number.isSafeInteger(spec.memoryLimitBytes) ||
          spec.memoryLimitBytes < 6 * 1024 * 1024)) ||
      (spec.cpuLimit !== undefined && (!Number.isFinite(spec.cpuLimit) || spec.cpuLimit <= 0)) ||
      spec.ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65535)
    ) {
      throw new DeskmatesError("validation", "invalid sandbox resource limits or ports");
    }
    for (const [path, name] of Object.entries(spec.volumes)) {
      if (
        !path.startsWith("/") ||
        path.includes(":") ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)
      ) {
        throw new DeskmatesError("validation", "invalid sandbox volume mapping");
      }
      const volume = await this.inspectVolume(name);
      if (
        volume !== undefined &&
        (volume.Labels?.[MANAGED_LABEL] !== "true" ||
          volume.Labels?.[WORKSPACE_LABEL] !== spec.workspaceId ||
          (spec.tenantId !== undefined && volume.Labels?.[TENANT_LABEL] !== spec.tenantId))
      ) {
        throw new DeskmatesError(
          "sandbox_unavailable",
          `volume ${name} ownership is unverified; preserve the old runtime and follow the legacy-volume recovery runbook`,
          { reason: "volume_ownership_mismatch", workspaceId: spec.workspaceId, volume: name },
        );
      }
    }
    await this.resolveImageId(spec.image);
    await this.resolveImageId(this.egressProxyImage);
    const network = await this.inspectNetwork(networkName(spec.workspaceId));
    if (
      network !== undefined &&
      (network.Internal !== true ||
        network.Labels?.[MANAGED_LABEL] !== "true" ||
        network.Labels?.[WORKSPACE_LABEL] !== spec.workspaceId ||
        (spec.tenantId !== undefined &&
          network.Labels?.[TENANT_LABEL] !== undefined &&
          network.Labels[TENANT_LABEL] !== spec.tenantId))
    )
      throw this.networkError(spec.workspaceId, "workspace network ownership is mismatched");
    const outbound = await this.inspectNetwork(EGRESS_OUTBOUND_NETWORK);
    if (
      outbound !== undefined &&
      (outbound.Internal || outbound.Labels?.[MANAGED_LABEL] !== "true")
    ) {
      throw this.networkError(spec.workspaceId, "outbound network configuration is mismatched");
    }
    const filters = encodeURIComponent(
      JSON.stringify({
        name: [containerName(spec.workspaceId), proxyName(spec.workspaceId)].map(
          (name) => `^/?${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        ),
      }),
    );
    const { json: containers } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    // removeStaleSandbox also removes leftover containers selected by labels, not only the
    // canonical names. Validate that exact selection too before any destructive call.
    const ownershipFilter = encodeURIComponent(
      JSON.stringify({
        label: [`${WORKSPACE_LABEL}=${spec.workspaceId}`, `${MANAGED_LABEL}=true`],
      }),
    );
    const { json: managed } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${ownershipFilter}`,
    );
    for (const container of [...containers, ...managed]) {
      const labels = container.Labels;
      if (
        labels?.[WORKSPACE_LABEL] !== spec.workspaceId ||
        labels?.[MANAGED_LABEL] !== "true" ||
        !["workspace", EGRESS_PROXY_ROLE].includes(labels?.[ROLE_LABEL] ?? "") ||
        (spec.tenantId !== undefined &&
          labels?.[TENANT_LABEL] !== spec.tenantId &&
          !(spec.tenantId === LEGACY_TENANT && labels?.[TENANT_LABEL] === undefined))
      ) {
        throw this.networkError(spec.workspaceId, "runtime ownership is mismatched");
      }
    }
  }

  async inspectVolatilePrerequisites(
    spec: SandboxSpec,
    requiredProviderRef?: string,
  ): Promise<readonly SandboxVolatilePrerequisite[]> {
    const path = "/root/.pki/nssdb";
    // Match the complete set removeStaleSandbox may remove, including stopped leftovers and
    // infrastructure. A first-match attach selection is not a replacement inventory.
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [`${WORKSPACE_LABEL}=${spec.workspaceId}`, `${MANAGED_LABEL}=true`],
      }),
    );
    const { json } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    const candidates = json.filter(
      (candidate) =>
        candidate.Labels?.[WORKSPACE_LABEL] === spec.workspaceId &&
        candidate.Labels?.[MANAGED_LABEL] === "true" &&
        ["workspace", EGRESS_PROXY_ROLE].includes(candidate.Labels?.[ROLE_LABEL] ?? ""),
    );
    for (const candidate of candidates) {
      const owner = candidate.Labels?.[TENANT_LABEL];
      if (
        spec.tenantId !== undefined &&
        (owner === undefined ? spec.tenantId !== LEGACY_TENANT : owner !== spec.tenantId)
      ) {
        throw this.networkError(
          spec.workspaceId,
          "replacement candidate is labelled for another tenant",
        );
      }
    }
    if (
      requiredProviderRef !== undefined &&
      !candidates.some(
        (candidate) =>
          candidate.Id === requiredProviderRef && candidate.Labels?.[ROLE_LABEL] === "workspace",
      ) &&
      // A cached container that Docker no longer has (docker rm -f, daemon restart) holds no
      // volatile state to preserve; destroying it is a no-op, so the restart may proceed. One
      // that still exists outside the verified inventory fails closed.
      (await this.client.request("GET", `/containers/${requiredProviderRef}/json`)).status !== 404
    ) {
      throw new DeskmatesError(
        "sandbox_unavailable",
        "cached replacement target is absent from the verified runtime inventory",
        {
          reason: "replacement_target_unverified",
          workspaceId: spec.workspaceId,
        },
      );
    }
    if (
      Object.keys(spec.volumes).some(
        (mount) => path === mount || path.startsWith(`${mount.replace(/\/$/, "")}/`),
      )
    )
      return [];
    const prerequisites: SandboxVolatilePrerequisite[] = [];
    for (const candidate of candidates) {
      // Engine changes exposes paths/kinds only. Never read/export NSS or arbitrary root state.
      const { json: changes } = await this.client.expect<{ Path: string; Kind: number }[] | null>(
        "GET",
        `/containers/${candidate.Id}/changes`,
        undefined,
        [200],
      );
      // Moby serializes the backend slice directly; an unchanged layer can be JSON null.
      // Only that successful empty result is accepted. Missing/malformed metadata fails closed.
      if (changes === null) continue;
      if (!Array.isArray(changes))
        throw new DeskmatesError(
          "sandbox_unavailable",
          "volatile prerequisite inspection returned no usable metadata",
          {
            reason: "volatile_inspection_failed",
            workspaceId: spec.workspaceId,
          },
        );
      if (
        changes.some(
          (change) =>
            change.Kind !== 2 &&
            ["cert9.db", "cert8.db"].some((name) => change.Path === `${path}/${name}`),
        )
      ) {
        prerequisites.push({
          code: "volatile_nss_database",
          path,
          sourceProviderRef: candidate.Id,
        });
      }
    }
    return prerequisites;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const egressAllowlist = spec.egressAllowlist;
    if (!Array.isArray(egressAllowlist)) {
      throw new DeskmatesError("validation", "egressAllowlist is required (use [] to deny all)");
    }
    validateVncPassword(spec);
    const binds: string[] = [];
    for (const [mountPath, volumeName] of Object.entries(spec.volumes)) {
      if (!mountPath.startsWith("/")) {
        throw new DeskmatesError(
          "validation",
          `volumes maps container path -> volume name; got key ${JSON.stringify(mountPath)}`,
        );
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(volumeName)) {
        throw new DeskmatesError("validation", `invalid volume name ${JSON.stringify(volumeName)}`);
      }
      binds.push(`${volumeName}:${mountPath}`);
    }
    for (const volumeName of Object.values(spec.volumes)) {
      await this.ensureWorkspaceVolume(volumeName, spec.workspaceId, spec.tenantId);
    }
    const envDir = this.envFilePath.slice(0, this.envFilePath.lastIndexOf("/")) || "/run/deskmates";
    const workspaceNetwork = networkName(spec.workspaceId);
    if ((await this.findManagedContainer(spec.workspaceId, "workspace")) !== undefined) {
      throw new DeskmatesError(
        "sandbox_unavailable",
        `container ${containerName(spec.workspaceId)} already exists for workspace ${spec.workspaceId}; use attach`,
        { reason: "already_exists", workspaceId: spec.workspaceId },
      );
    }
    await this.ensureOutboundNetwork();
    const workspaceNetworkCreated = await this.ensureWorkspaceNetwork(
      spec.workspaceId,
      spec.tenantId,
    );
    let proxyId: string | undefined;
    let containerId: string | undefined;
    try {
      proxyId = await this.createProxy(
        spec.workspaceId,
        egressAllowlist,
        undefined,
        spec.tenantId,
        spec.egressGrants ?? [],
      );
      const proxy = await this.inspect(proxyId);
      const proxyIp = proxy.NetworkSettings.Networks?.[workspaceNetwork]?.IPAddress;
      if (!proxyIp) {
        throw this.networkError(spec.workspaceId, "egress proxy has no workspace-network address");
      }
      const proxyUrl = `http://egress-proxy:${EGRESS_PROXY_PORT}`;
      const env = {
        ...spec.env,
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
        http_proxy: proxyUrl,
        https_proxy: proxyUrl,
        NO_PROXY: "localhost,127.0.0.1,[::1],::1",
        no_proxy: "localhost,127.0.0.1,[::1],::1",
        DESKMATES_EGRESS_PROXY: proxyUrl,
      };
      const body = {
        Image: spec.image,
        Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
        Labels: {
          [WORKSPACE_LABEL]: spec.workspaceId,
          [MANAGED_LABEL]: "true",
          [ROLE_LABEL]: "workspace",
          ...tenantLabels(spec.tenantId),
        },
        ...(this.containerCommand === undefined ? {} : { Cmd: [...this.containerCommand] }),
        ExposedPorts: {},
        NetworkingConfig: { EndpointsConfig: { [workspaceNetwork]: {} } },
        HostConfig: {
          Binds: binds,
          PortBindings: {},
          ShmSize: this.shmSizeBytes,
          ...(spec.memoryLimitBytes === undefined ? {} : { Memory: spec.memoryLimitBytes }),
          ...(spec.cpuLimit === undefined ? {} : { NanoCpus: Math.round(spec.cpuLimit * 1e9) }),
          // tmpfs for the injected env file: never on the writable layer, gone with the container.
          Tmpfs: { [envDir]: "rw,nosuid,nodev,noexec,size=1m,mode=0700" },
          ExtraHosts: [...this.extraHosts, `egress-proxy:${proxyIp}`],
          // Do not let arbitrary DNS questions escape through Docker's embedded resolver. The
          // proxy name is pinned in /etc/hosts above; the proxy alone resolves public names.
          Dns: ["127.0.0.1"],
          NetworkMode: workspaceNetwork,
          RestartPolicy: { Name: "unless-stopped" },
          // Nothing in the workspace image needs a Linux capability. Chromium runs with
          // --no-sandbox (no CAP_SYS_ADMIN for its own namespace sandbox); Xvfb, x11vnc and
          // websockify bind unprivileged ports only; every process runs as root and owns the
          // files it touches, so CAP_DAC_OVERRIDE and CAP_CHOWN are unused too. If a future
          // component needs one, add it back here explicitly with CapAdd and say why.
          CapDrop: ["ALL"],
          // setuid binaries in the image (Debian ships a few) cannot gain privileges from a
          // process started here, so a shell escape inside the sandbox stays unprivileged.
          SecurityOpt: ["no-new-privileges"],
          // Chromium plus a few runs' worth of sidecars sit far below this; the cap turns a fork
          // bomb inside the sandbox into a failing tool call instead of a wedged host.
          PidsLimit: 4096,
        },
      };
      const name = containerName(spec.workspaceId);
      const res = await this.client.request("POST", `/containers/create?name=${name}`, body);
      if (res.status === 404) {
        throw new DeskmatesError("sandbox_unavailable", `image not found: ${spec.image}`, {
          reason: "image_missing",
          image: spec.image,
        });
      }
      if (res.status === 409) {
        throw new DeskmatesError(
          "sandbox_unavailable",
          `container ${name} already exists for workspace ${spec.workspaceId}; use attach`,
          { reason: "already_exists", workspaceId: spec.workspaceId },
        );
      }
      if (res.status !== 201) throw dockerApiError("POST", "/containers/create", res);
      const { Id } = JSON.parse(res.body) as { Id: string };
      containerId = Id;
      await this.start(Id);
      // POST /start returns as soon as the container's init is running, long before Chromium
      // listens on 9222. Hand back a handle only once the image says it is ready.
      await this.waitUntilReady(Id, spec.workspaceId);
      return this.handleFor(spec.workspaceId, Id);
    } catch (error) {
      if (containerId !== undefined) await this.removeContainer(containerId);
      if (proxyId !== undefined) await this.removeContainer(proxyId);
      if (workspaceNetworkCreated) await this.removeNetwork(workspaceNetwork);
      throw error;
    }
  }

  async isPresent(handle: SandboxHandle): Promise<boolean> {
    const path = `/containers/${encodeURIComponent(handle.providerRef)}/json`;
    const response = await this.client.request("GET", path);
    if (response.status === 404) return false;
    if (response.status !== 200) throw dockerApiError("GET", path, response);
    let container: ContainerInspect | null;
    try {
      container = JSON.parse(response.body) as ContainerInspect | null;
    } catch {
      throw new DeskmatesError("sandbox_unavailable", "Docker returned an invalid inspection");
    }
    const labels = container?.Config?.Labels;
    if (
      labels?.[WORKSPACE_LABEL] !== handle.workspaceId ||
      labels?.[MANAGED_LABEL] !== "true" ||
      labels?.[ROLE_LABEL] !== "workspace"
    ) {
      throw this.networkError(handle.workspaceId, "cached workspace ownership is mismatched");
    }
    return true;
  }

  async attach(workspaceId: WorkspaceId, tenantId?: string): Promise<SandboxHandle | undefined> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [`${WORKSPACE_LABEL}=${workspaceId}`, `${MANAGED_LABEL}=true`],
      }),
    );
    const { json } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    // The label filter is a hint, not a contract: an old daemon, a hand-made container or a
    // stale stopped one can match. Require both labels and prefer a container that is running,
    // so a leftover exited container never shadows the live workspace.
    const managed = json.filter(
      (c) => c.Labels?.[WORKSPACE_LABEL] === workspaceId && c.Labels?.[MANAGED_LABEL] === "true",
    );
    const candidates = managed.filter((c) => c.Labels?.[ROLE_LABEL] === "workspace");
    if (candidates.length === 0 && managed.some((c) => c.Labels?.[ROLE_LABEL] === undefined)) {
      throw this.networkError(workspaceId, "legacy workspace has no managed network role");
    }
    const found = candidates.find((c) => c.State === "running") ?? candidates[0];
    if (!found) return undefined;
    if (tenantId !== undefined) {
      // A wrong or missing owner label fails closed: never hand one tenant's browser, files and
      // screen to another (ADR-0022 DOCKER-01). Unlabelled sandboxes predate tenants and all
      // belong to the Default Tenant.
      const owner = found.Labels?.[TENANT_LABEL];
      if (owner === undefined ? tenantId !== LEGACY_TENANT : owner !== tenantId)
        throw this.networkError(workspaceId, "workspace sandbox is labelled for another tenant");
    }
    const inspect = await this.inspect(found.Id);
    if (
      inspect.HostConfig?.ExtraHosts?.some((entry) =>
        entry.toLowerCase().startsWith(`${DEFAULT_HOST_TARGET}:`),
      )
    ) {
      throw this.networkError(workspaceId, "legacy workspace has a direct host alias");
    }
    const currentNetworks = Object.keys(inspect.NetworkSettings.Networks ?? {});
    const expectedNetwork = networkName(workspaceId);
    if (
      currentNetworks.length > 0 &&
      (currentNetworks.length !== 1 || currentNetworks[0] !== expectedNetwork)
    ) {
      throw this.networkError(
        workspaceId,
        "workspace is attached to a legacy or mismatched network",
      );
    }
    // A network or proxy recreated here carries the workspace container's owner label, as
    // `create` would have set it; without it preflight, restart, the image upgrade and permanent
    // deletion refuse the workspace as mismatched (ADR-0022 DOCKER-01).
    const ownerTenant = found.Labels?.[TENANT_LABEL];
    await this.ensureOutboundNetwork();
    await this.ensureWorkspaceNetwork(workspaceId, ownerTenant);
    await this.assertWorkspaceNetwork(workspaceId, found.Id, inspect);
    const pinnedProxyIp = proxyIpFromExtraHosts(inspect.HostConfig?.ExtraHosts);
    let attachedProxy = await this.findAndValidateProxy(
      workspaceId,
      true,
      pinnedProxyIp,
      ownerTenant,
    );
    let attachedProxyIp =
      attachedProxy.NetworkSettings.Networks?.[networkName(workspaceId)]?.IPAddress;
    if (pinnedProxyIp !== undefined && attachedProxyIp !== pinnedProxyIp) {
      attachedProxy = await this.repinProxy(workspaceId, inspect, attachedProxy, pinnedProxyIp);
      attachedProxyIp =
        attachedProxy.NetworkSettings.Networks?.[networkName(workspaceId)]?.IPAddress;
    }
    if (pinnedProxyIp === undefined || attachedProxyIp !== pinnedProxyIp) {
      throw this.networkError(workspaceId, "workspace egress-proxy address is missing or stale");
    }
    this.vncPasswordFromInspect(workspaceId, inspect);
    if (!inspect.State.Running) {
      await this.start(found.Id);
    } else if (inspect.State.Health?.Status === "unhealthy") {
      // The desktop is up but broken (entry.sh exits when Chromium dies, but websockify or
      // Xvfb can die on their own and leave the container running and unhealthy forever).
      // Nothing else recovers it: `unless-stopped` only reacts to the init process exiting.
      await this.restart(found.Id);
    }
    await this.waitUntilReady(found.Id, workspaceId);
    return this.handleFor(workspaceId, found.Id);
  }

  /**
   * Upgrade path: remove the workspace container and its egress proxy when either runs an image
   * other than the one `create` would use now (`image`, `egressProxyImage`). The pair goes
   * together even when only the proxy drifted: the workspace pins the proxy's address in its
   * /etc/hosts and gets its VNC credentials and proxy environment at create, so recreating both
   * from one spec is the only path that is exactly a fresh `create`. The workspace network and
   * the named volumes stay. Image references are resolved by inspect only; a configured image
   * that is not present is `image_missing` before anything is stopped.
   */
  async removeStaleSandbox(
    workspaceId: WorkspaceId,
    image: string,
    beforeRemove?: (drift: readonly SandboxImageDrift[]) => Promise<void>,
  ): Promise<readonly SandboxImageDrift[]> {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${WORKSPACE_LABEL}=${workspaceId}`, `${MANAGED_LABEL}=true`] }),
    );
    const { json } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    const managed = json.filter(
      (c) => c.Labels?.[WORKSPACE_LABEL] === workspaceId && c.Labels?.[MANAGED_LABEL] === "true",
    );
    const workspaces = managed.filter((c) => c.Labels?.[ROLE_LABEL] === "workspace");
    const proxies = managed.filter((c) => c.Labels?.[ROLE_LABEL] === EGRESS_PROXY_ROLE);
    if (workspaces.length === 0 && proxies.length === 0) return [];
    // Resolve both before touching anything, so a missing image fails closed on a live sandbox.
    const configuredWorkspace = await this.resolveImageId(image);
    const configuredProxy = await this.resolveImageId(this.egressProxyImage);
    // Compare the containers attach would pick: the running workspace, else the first one; the
    // first proxy, as findManagedContainer does.
    const current = workspaces.find((c) => c.State === "running") ?? workspaces[0];
    const drift: SandboxImageDrift[] = [];
    const compare = (component: string, found: ContainerSummary | undefined, want: string) => {
      if (found === undefined || found.ImageID === want) return;
      drift.push({
        component,
        runningImageId: found.ImageID ?? "unknown",
        configuredImageId: want,
      });
    };
    compare("workspace", current, configuredWorkspace);
    compare(EGRESS_PROXY_ROLE, proxies[0], configuredProxy);
    if (drift.length === 0) return [];
    await beforeRemove?.(drift);
    // Every managed container of the workspace goes, including leftover stopped ones, or the
    // following create would be refused as already_exists.
    for (const container of [...workspaces, ...proxies]) await this.removeContainer(container.Id);
    return drift;
  }

  async exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
    if (req.cmd.length === 0) throw new DeskmatesError("validation", "exec: cmd must not be empty");
    const marker = randomUUID();
    let result: ExecResult;
    try {
      result = await this.runExec(handle.providerRef, req, marker);
    } catch (error) {
      // Losing the Docker stream does not stop its process either. Do not leave
      // a run executing merely because its output/exit receipt was lost.
      await this.killByMarker(handle.providerRef, marker);
      throw error;
    }
    if (result.timedOut) await this.killByMarker(handle.providerRef, marker);
    return result;
  }

  /**
   * ADR-0029 decision 4: the sidecar of a run whose Gateway is gone. The scheduler sets
   * `RUN_MARKER_ENV=<runId>` on every sidecar exec, so this finds it by environment like the
   * deadline kill finds an exec by its marker. New images drain the matching subreaper
   * before legacy cleanup, so detached descendants need no inherited marker. A run id is a Gateway id (`[A-Za-z0-9_-]`); anything
   * else is refused rather than put in a shell pattern.
   */
  async killRun(handle: SandboxHandle, runId: string): Promise<void> {
    if (!/^[A-Za-z0-9_.-]+$/.test(runId))
      throw new DeskmatesError("validation", "killRun: not a run id", { runId });
    await this.killByEnv(handle.providerRef, RUN_MARKER_ENV, runId);
  }

  async injectEnv(handle: SandboxHandle, env: Readonly<Record<string, string>>): Promise<void> {
    const content = renderEnvFile(env);
    // Values travel on stdin: exec argv is visible in `docker inspect` of the exec, stdin is not.
    const script =
      'umask 077 && mkdir -p "$(dirname "$0")" && cat > "$0.tmp" && mv -f "$0.tmp" "$0"';
    const res = await this.runExec(
      handle.providerRef,
      { cmd: ["/bin/sh", "-c", script, this.envFilePath], stdin: content, timeoutMs: 15_000 },
      randomUUID(),
    );
    if (res.exitCode !== 0 || res.timedOut) {
      throw new DeskmatesError("sandbox_unavailable", `injectEnv failed: ${res.stderr.trim()}`, {
        exitCode: res.exitCode,
        timedOut: res.timedOut,
      });
    }
  }

  async updateEgress(
    handle: SandboxHandle,
    allowlist: readonly string[],
    grants: readonly NetworkGrant[] = [],
  ): Promise<EgressAcknowledgement> {
    const proxy = await this.findAndValidateProxy(handle.workspaceId);
    try {
      return await this.replaceProxyPolicy(proxy.Id, allowlist, handle.workspaceId, grants);
    } catch (error) {
      // Continuing on the old policy after a failed revocation would be fail-open. Stop the
      // proxy: the internal workspace network then has no public route at all.
      await this.stopContainer(proxy.Id);
      throw error;
    }
  }

  /**
   * Runs the egress image's probe inside the workspace's proxy: the network position every
   * workspace request has (ADR-0027 amendment 1 decision 14). The request travels on stdin.
   */
  async probeEgress(
    handle: SandboxHandle,
    request: EgressProbeRequest,
  ): Promise<EgressProbeResult> {
    const proxy = await this.findAndValidateProxy(handle.workspaceId);
    const result = await this.runExec(
      proxy.Id,
      {
        cmd: ["node", "/opt/deskmates/egress-probe.mjs"],
        stdin: JSON.stringify(request),
        timeoutMs: 30_000,
      },
      randomUUID(),
    );
    const line = result.stdout.trim().split("\n").at(-1) ?? "";
    try {
      if (result.exitCode !== 0 || result.timedOut) throw new Error("probe failed");
      return JSON.parse(line) as EgressProbeResult;
    } catch {
      throw new DeskmatesError("sandbox_unavailable", "the egress proxy could not run the probe", {
        reason: "egress_probe_unavailable",
      });
    }
  }

  /** ADR-0027 amendment 2 decision 15: the IPv4 subnets of every network on this daemon. */
  async networkSubnets(): Promise<SandboxNetworkSubnet[]> {
    const { json } = await this.client.expect<NetworkSummary[]>("GET", "/networks");
    return networkSubnetsOf(json);
  }

  /**
   * Amendment 2 decision 16: attach's topology rules for a cached handle's workspace container.
   * Read-only; the proxy half is checked by every `updateEgress`, which the registry runs next.
   */
  async verifyTopology(handle: SandboxHandle): Promise<void> {
    const { workspaceId } = handle;
    const res = await this.client.request("GET", `/containers/${handle.providerRef}/json`);
    if (res.status === 404) throw this.networkError(workspaceId, "workspace container is gone");
    if (res.status !== 200)
      throw dockerApiError("GET", `/containers/${handle.providerRef}/json`, res);
    const problem = topologyProblem(JSON.parse(res.body) as ContainerInspect, {
      labels: {
        [WORKSPACE_LABEL]: workspaceId,
        [MANAGED_LABEL]: "true",
        [ROLE_LABEL]: "workspace",
      },
      network: networkName(workspaceId),
      hostAlias: DEFAULT_HOST_TARGET,
    });
    if (problem !== undefined) throw this.networkError(workspaceId, problem);
  }

  /**
   * ADR-0006 amendment 5 decision 11: every container, network and volume labelled as ours,
   * the networks a former product name left behind, and the daemon's address pools. GET only.
   */
  async listHostResources(): Promise<HostResourceInventory> {
    const label = encodeURIComponent(JSON.stringify({ label: [`${MANAGED_LABEL}=true`] }));
    const { json: containers } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&size=true&filters=${label}`,
    );
    const resources: HostResource[] = [];
    for (const c of containers) {
      const workspaceId = c.Labels?.[WORKSPACE_LABEL];
      const role = c.Labels?.[ROLE_LABEL];
      if (c.Labels?.[MANAGED_LABEL] !== "true" || workspaceId === undefined) continue;
      const resource: HostResource = {
        kind: "container",
        name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
        id: c.Id,
        workspaceId,
        ...(role === undefined ? {} : { role }),
        ...(c.Created === undefined ? {} : { createdAt: new Date(c.Created * 1000).toISOString() }),
        ...(c.SizeRw === undefined ? {} : { sizeBytes: c.SizeRw }),
        state: c.State,
      };
      if (role === "workspace") {
        const problem = await this.topologyOf(c.Id, workspaceId as WorkspaceId);
        if (problem !== undefined) resource.topologyProblem = problem;
        if (c.State === "running") resource.sidecarProcesses = await this.sidecarProcesses(c.Id);
      }
      resources.push(resource);
    }
    const { json: networks } = await this.client.expect<NetworkListEntry[]>("GET", "/networks");
    for (const n of networks) {
      const own = n.Labels?.[MANAGED_LABEL] === "true" ? n.Labels?.[WORKSPACE_LABEL] : undefined;
      const former = own === undefined ? formerNameNetwork(n, RESOURCE_PREFIX) : undefined;
      if (own === undefined && former === undefined) continue;
      const inspected = await this.inspectNetwork(n.Name);
      const workspaceId = own ?? former?.workspaceId;
      resources.push({
        kind: "network",
        name: n.Name,
        id: n.Id,
        ...(workspaceId === undefined ? {} : { workspaceId }),
        role: own === undefined ? "legacy" : "workspace",
        ...(n.Created === undefined ? {} : { createdAt: new Date(n.Created).toISOString() }),
        attachedContainers: Object.keys(inspected?.Containers ?? {}).length,
      });
    }
    const { json: volumes } = await this.client.expect<{ Volumes?: VolumeListEntry[] | null }>(
      "GET",
      `/volumes?filters=${label}`,
    );
    const sizes = await this.volumeSizes();
    for (const v of volumes.Volumes ?? []) {
      const workspaceId = v.Labels?.[WORKSPACE_LABEL];
      if (v.Labels?.[MANAGED_LABEL] !== "true" || workspaceId === undefined) continue;
      const size = sizes.get(v.Name);
      resources.push({
        kind: "volume",
        name: v.Name,
        id: v.Name,
        workspaceId,
        role: "volume",
        ...(v.CreatedAt === undefined ? {} : { createdAt: new Date(v.CreatedAt).toISOString() }),
        ...(size === undefined ? {} : { sizeBytes: size }),
      });
    }
    const { json: info } = await this.client.expect<DaemonInfo>("GET", "/info");
    const pools = (info.DefaultAddressPools ?? []).map((p) => ({ base: p.Base, size: p.Size }));
    return {
      resources,
      ...(pools.length > 0 ? { addressPools: pools } : {}),
      subnets: networkSubnetsOf(networks),
    };
  }

  /**
   * Decision 13: remove what a finding names, each piece's ownership checked again. A workspace:
   * its containers (the workspace container first, then the proxy), its labelled networks, then
   * its labelled volumes unless they are kept. A former-name network: only while nothing is
   * attached, and only when the former-name rule still matches it.
   */
  async removeHostResources(target: HostResourceTarget): Promise<HostResource[]> {
    const removed: HostResource[] = [];
    if (target.kind === "network") {
      const network = await this.inspectNetwork(target.name);
      if (network === undefined) return removed;
      if (formerNameNetwork(network, RESOURCE_PREFIX) === undefined)
        throw new DeskmatesError(
          "validation",
          `network ${target.name} is not a former-name network`,
        );
      if (Object.keys(network.Containers ?? {}).length > 0)
        throw new DeskmatesError(
          "invalid_transition",
          `network ${target.name} still has containers attached`,
          { reason: "network_in_use" },
        );
      await this.removeNetwork(network.Name);
      return [{ kind: "network", name: network.Name, id: network.Id, role: "legacy" }];
    }
    const { workspaceId } = target;
    const owned = (labels: Record<string, string> | null | undefined) =>
      labels?.[WORKSPACE_LABEL] === workspaceId && labels?.[MANAGED_LABEL] === "true";
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${WORKSPACE_LABEL}=${workspaceId}`, `${MANAGED_LABEL}=true`] }),
    );
    const { json: containers } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    const rank = (c: ContainerSummary) =>
      c.Labels?.[ROLE_LABEL] === "workspace"
        ? 0
        : c.Labels?.[ROLE_LABEL] === EGRESS_PROXY_ROLE
          ? 1
          : 2;
    for (const c of containers.filter((c) => owned(c.Labels)).sort((a, b) => rank(a) - rank(b))) {
      await this.removeContainer(c.Id);
      removed.push({
        kind: "container",
        name: (c.Names?.[0] ?? c.Id).replace(/^\//, ""),
        id: c.Id,
        workspaceId,
        ...(c.Labels?.[ROLE_LABEL] === undefined ? {} : { role: c.Labels[ROLE_LABEL] }),
      });
    }
    const { json: networks } = await this.client.expect<NetworkListEntry[]>(
      "GET",
      `/networks?filters=${filters}`,
    );
    for (const n of networks.filter((n) => owned(n.Labels))) {
      await this.removeNetwork(n.Name);
      removed.push({ kind: "network", name: n.Name, id: n.Id, workspaceId, role: "workspace" });
    }
    if (target.keepVolumes) return removed;
    const { json: volumes } = await this.client.expect<{ Volumes?: VolumeListEntry[] | null }>(
      "GET",
      `/volumes?filters=${filters}`,
    );
    for (const v of (volumes.Volumes ?? []).filter((v) => owned(v.Labels))) {
      const res = await this.client.request(
        "DELETE",
        `/volumes/${encodeURIComponent(v.Name)}?force=true`,
      );
      if (![204, 404].includes(res.status))
        throw dockerApiError("DELETE", `/volumes/${v.Name}`, res);
      removed.push({ kind: "volume", name: v.Name, id: v.Name, workspaceId, role: "volume" });
    }
    return removed;
  }

  /**
   * Decision 13: `repinProxy` generalised to any network. The workspace container and its proxy
   * leave every network that is not theirs, the workspace network is created when missing, both
   * join it with their aliases (the proxy at the address the workspace pins, when the daemon can
   * give it), and the container is inspected again. Nothing is recreated.
   */
  async reattachWorkspaceNetwork(workspaceId: WorkspaceId): Promise<{ problem?: string }> {
    const found = await this.findManagedContainer(workspaceId, "workspace");
    if (found === undefined)
      throw new DeskmatesError("not_found", `workspace ${workspaceId} has no container`, {
        workspaceId,
      });
    const workspace = await this.inspect(found.Id);
    const expected = networkName(workspaceId);
    await this.ensureOutboundNetwork();
    await this.ensureWorkspaceNetwork(workspaceId, workspace.Config.Labels?.[TENANT_LABEL]);
    const endpoints = workspace.NetworkSettings.Networks ?? {};
    let aliases: string[] = [];
    for (const [name, endpoint] of Object.entries(endpoints)) {
      if (name === expected) continue;
      // Docker lists the container's own short id among the aliases; it adds that one itself.
      if (aliases.length === 0)
        aliases = (endpoint.Aliases ?? []).filter((alias) => !workspace.Id.startsWith(alias));
      await this.disconnectNetwork(name, workspace.Id);
    }
    if (endpoints[expected] === undefined)
      await this.connectNetwork(
        expected,
        workspace.Id,
        aliases.length === 0 ? undefined : { Aliases: aliases },
      );
    const pinned = proxyIpFromExtraHosts(workspace.HostConfig?.ExtraHosts);
    const proxySummary = await this.findManagedContainer(workspaceId, EGRESS_PROXY_ROLE);
    if (proxySummary !== undefined) {
      const proxy = await this.inspect(proxySummary.Id);
      const proxyEndpoints = proxy.NetworkSettings.Networks ?? {};
      for (const name of Object.keys(proxyEndpoints))
        if (name !== expected && name !== EGRESS_OUTBOUND_NETWORK)
          await this.disconnectNetwork(name, proxy.Id);
      if (proxyEndpoints[expected] === undefined) {
        try {
          await this.connectNetwork(expected, proxy.Id, {
            Aliases: ["egress-proxy"],
            ...(pinned === undefined ? {} : { IPAMConfig: { IPv4Address: pinned } }),
          });
        } catch (error) {
          // The pinned address belongs to another subnet or is taken: join without it, and let
          // the inspection below report the stale pin rather than leave the proxy off-network.
          if (pinned === undefined) throw error;
          await this.connectNetwork(expected, proxy.Id, { Aliases: ["egress-proxy"] });
        }
      }
      if (proxyEndpoints[EGRESS_OUTBOUND_NETWORK] === undefined)
        await this.connectNetwork(EGRESS_OUTBOUND_NETWORK, proxy.Id);
    }
    const problem = await this.topologyOf(workspace.Id, workspaceId);
    if (problem !== undefined) return { problem };
    const proxyNow = proxySummary === undefined ? undefined : await this.inspect(proxySummary.Id);
    if (
      pinned === undefined ||
      proxyNow?.NetworkSettings.Networks?.[expected]?.IPAddress !== pinned
    )
      return { problem: "workspace egress-proxy address is missing or stale" };
    return {};
  }

  /** The topology rule `verifyTopology` applies, as a verdict; undefined when accepted. */
  private async topologyOf(id: string, workspaceId: WorkspaceId): Promise<string | undefined> {
    return topologyProblem(await this.inspect(id), {
      labels: {
        [WORKSPACE_LABEL]: workspaceId,
        [MANAGED_LABEL]: "true",
        [ROLE_LABEL]: "workspace",
      },
      network: networkName(workspaceId),
      hostAlias: DEFAULT_HOST_TARGET,
    });
  }

  /** Sidecar processes in a running container: some Gateway's run is executing there. */
  private async sidecarProcesses(id: string): Promise<number> {
    const res = await this.client.request("GET", `/containers/${id}/top`);
    if (res.status !== 200) return 0;
    const top = JSON.parse(res.body) as { Titles?: string[]; Processes?: string[][] | null };
    const column = Math.max(
      0,
      (top.Titles ?? []).findIndex((t) => t === "CMD" || t === "COMMAND"),
    );
    return (top.Processes ?? []).filter((p) =>
      (p[column] ?? p.join(" ")).includes("deskmates-sidecar"),
    ).length;
  }

  /** Volume sizes from the daemon's disk usage; empty when it cannot tell. */
  private async volumeSizes(): Promise<Map<string, number>> {
    const sizes = new Map<string, number>();
    const res = await this.client.request("GET", "/system/df?type=volume");
    if (res.status !== 200) return sizes;
    const df = JSON.parse(res.body) as {
      Volumes?: { Name: string; UsageData?: { Size?: number } | null }[] | null;
    };
    for (const v of df.Volumes ?? [])
      if (v.UsageData?.Size !== undefined && v.UsageData.Size >= 0)
        sizes.set(v.Name, v.UsageData.Size);
    return sizes;
  }

  async snapshot(handle: SandboxHandle): Promise<SandboxSnapshot> {
    const takenAt = new Date().toISOString();
    const tag = `${sanitize(handle.workspaceId)}-${takenAt.replace(/[-:.]/g, "").toLowerCase()}`;
    const q = `container=${handle.providerRef}&repo=deskmates%2Fsnapshot&tag=${tag}&pause=true`;
    const { json } = await this.client.expect<{ Id: string }>("POST", `/commit?${q}`, {});
    return { takenAt, ref: json.Id };
  }

  async destroy(handle: SandboxHandle): Promise<void> {
    await this.removeContainer(handle.providerRef);
    const proxy = await this.findManagedContainer(handle.workspaceId, EGRESS_PROXY_ROLE);
    if (proxy !== undefined) await this.removeContainer(proxy.Id);
    await this.removeNetwork(networkName(handle.workspaceId));
  }

  async permanentlyDelete(workspaceId: WorkspaceId, tenantId?: string): Promise<void> {
    const filters = encodeURIComponent(
      JSON.stringify({ label: [`${WORKSPACE_LABEL}=${workspaceId}`, `${MANAGED_LABEL}=true`] }),
    );
    const { json } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    for (const container of json) {
      // Docker's label filter is only a hint. Ignore an unrelated row if a daemon or test double
      // returns one; never turn the query into prefix cleanup or remove the peer.
      if (
        container.Labels?.[WORKSPACE_LABEL] !== workspaceId ||
        container.Labels?.[MANAGED_LABEL] !== "true"
      )
        continue;
      if (tenantId !== undefined && container.Labels?.[TENANT_LABEL] !== tenantId) {
        throw this.networkError(workspaceId, "managed container ownership is mismatched");
      }
      await this.removeContainer(container.Id);
    }
    const network = await this.inspectNetwork(networkName(workspaceId));
    if (network !== undefined) {
      if (
        network.Labels?.[WORKSPACE_LABEL] !== workspaceId ||
        network.Labels?.[MANAGED_LABEL] !== "true" ||
        (tenantId !== undefined && network.Labels?.[TENANT_LABEL] !== tenantId)
      ) {
        throw this.networkError(workspaceId, "managed network ownership is mismatched");
      }
      await this.removeNetwork(network.Name);
    }
    for (const suffix of ["profile", "work", "home"] as const) {
      const name = `deskmates-${workspaceId}-${suffix}`;
      const volume = await this.inspectVolume(name);
      if (volume === undefined) continue;
      if (
        volume.Labels?.[WORKSPACE_LABEL] !== workspaceId ||
        volume.Labels?.[MANAGED_LABEL] !== "true" ||
        (tenantId !== undefined && volume.Labels?.[TENANT_LABEL] !== tenantId)
      ) {
        throw this.networkError(workspaceId, `volume ${name} ownership is mismatched`);
      }
      const removed = await this.client.request(
        "DELETE",
        `/volumes/${encodeURIComponent(name)}?force=true`,
      );
      if (![204, 404].includes(removed.status)) {
        throw dockerApiError("DELETE", `/volumes/${name}`, removed);
      }
    }
  }

  // --- internals ---

  private async ensureWorkspaceNetwork(
    workspaceId: WorkspaceId,
    tenantId?: string,
  ): Promise<boolean> {
    const name = networkName(workspaceId);
    const existing = await this.inspectNetwork(name);
    if (existing !== undefined) {
      const owner = existing.Labels?.[TENANT_LABEL];
      if (
        existing.Internal !== true ||
        existing.Labels?.[MANAGED_LABEL] !== "true" ||
        existing.Labels?.[WORKSPACE_LABEL] !== workspaceId ||
        (tenantId !== undefined && owner !== undefined && owner !== tenantId)
      ) {
        throw this.networkError(workspaceId, `network ${name} exists with mismatched ownership`);
      }
      return false;
    }
    const res = await this.client.request("POST", "/networks/create", {
      Name: name,
      CheckDuplicate: true,
      Internal: true,
      Labels: {
        [MANAGED_LABEL]: "true",
        [WORKSPACE_LABEL]: workspaceId,
        ...tenantLabels(tenantId),
      },
    });
    if (res.status === 409) {
      const raced = await this.inspectNetwork(name);
      if (
        raced?.Internal === true &&
        raced.Labels?.[MANAGED_LABEL] === "true" &&
        raced.Labels?.[WORKSPACE_LABEL] === workspaceId
      ) {
        return false;
      }
    }
    if (res.status !== 201) throw dockerApiError("POST", "/networks/create", res);
    return true;
  }

  private async ensureWorkspaceVolume(
    name: string,
    workspaceId: WorkspaceId,
    tenantId?: string,
  ): Promise<void> {
    const existing = await this.inspectVolume(name);
    if (existing !== undefined) {
      if (
        existing.Labels?.[MANAGED_LABEL] !== "true" ||
        existing.Labels?.[WORKSPACE_LABEL] !== workspaceId ||
        (tenantId !== undefined && existing.Labels?.[TENANT_LABEL] !== tenantId)
      ) {
        throw this.networkError(workspaceId, `volume ${name} exists with mismatched ownership`);
      }
      return;
    }
    const res = await this.client.request("POST", "/volumes/create", {
      Name: name,
      Labels: {
        [MANAGED_LABEL]: "true",
        [WORKSPACE_LABEL]: workspaceId,
        ...tenantLabels(tenantId),
      },
    });
    if (![201, 409].includes(res.status)) throw dockerApiError("POST", "/volumes/create", res);
    const created = await this.inspectVolume(name);
    if (
      created?.Labels?.[MANAGED_LABEL] !== "true" ||
      created.Labels?.[WORKSPACE_LABEL] !== workspaceId ||
      (tenantId !== undefined && created.Labels?.[TENANT_LABEL] !== tenantId)
    ) {
      throw this.networkError(workspaceId, `volume ${name} creation raced with another owner`);
    }
  }

  private async inspectVolume(name: string): Promise<VolumeInspect | undefined> {
    const res = await this.client.request("GET", `/volumes/${encodeURIComponent(name)}`);
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw dockerApiError("GET", `/volumes/${name}`, res);
    return JSON.parse(res.body) as VolumeInspect;
  }

  private async ensureOutboundNetwork(): Promise<void> {
    const existing = await this.inspectNetwork(EGRESS_OUTBOUND_NETWORK);
    if (existing !== undefined) {
      if (existing.Internal || existing.Labels?.[MANAGED_LABEL] !== "true") {
        throw new DeskmatesError(
          "sandbox_unavailable",
          "managed egress outbound network has mismatched configuration",
          { reason: "network_mismatch" },
        );
      }
      return;
    }
    const res = await this.client.request("POST", "/networks/create", {
      Name: EGRESS_OUTBOUND_NETWORK,
      CheckDuplicate: true,
      Internal: false,
      Labels: { [MANAGED_LABEL]: "true", [ROLE_LABEL]: "egress-outbound" },
    });
    if (res.status === 409) {
      const raced = await this.inspectNetwork(EGRESS_OUTBOUND_NETWORK);
      if (raced?.Internal === false && raced.Labels?.[MANAGED_LABEL] === "true") return;
    }
    if (res.status !== 201) throw dockerApiError("POST", "/networks/create", res);
  }

  private async inspectNetwork(name: string): Promise<NetworkInspect | undefined> {
    const path = `/networks/${encodeURIComponent(name)}`;
    const res = await this.client.request("GET", path);
    if (res.status === 404) return undefined;
    if (res.status !== 200) throw dockerApiError("GET", path, res);
    return JSON.parse(res.body) as NetworkInspect;
  }

  private async createProxy(
    workspaceId: WorkspaceId,
    allowlist: readonly string[],
    internalIp?: string,
    tenantId?: string,
    grants: readonly NetworkGrant[] = [],
  ): Promise<string> {
    const workspaceNetwork = networkName(workspaceId);
    const outboundGateway = networkGatewayAddress(
      await this.inspectNetwork(EGRESS_OUTBOUND_NETWORK),
    );
    if (!outboundGateway) {
      throw this.networkError(workspaceId, "egress outbound network has no gateway address");
    }
    const body = {
      Image: this.egressProxyImage,
      // Policy is deliberately absent from persistent container configuration. Every proxy
      // process start is deny-all; create applies the current policy below before the workspace
      // can start, and attach reapplies the Gateway's persisted policy.
      Env: [
        `DESKMATES_SCREEN_TARGET=${containerName(workspaceId)}`,
        // Per proxy container; only the Gateway reads it back (ADR-0035 decision 4).
        `${APP_RELAY_KEY_ENV}=${randomBytes(16).toString("hex")}`,
        `DESKMATES_HOST_TARGET=${this.hostTarget}`,
        `DESKMATES_HOST_FALLBACK_IP=${outboundGateway}`,
        // Where port-53 DNS is intercepted with fake IPs, the proxy resolves over DoH instead.
        ...(this.egressProxyDohUrl === undefined
          ? []
          : [`DESKMATES_DOH_URL=${this.egressProxyDohUrl}`]),
      ],
      Labels: {
        [WORKSPACE_LABEL]: workspaceId,
        [MANAGED_LABEL]: "true",
        [ROLE_LABEL]: EGRESS_PROXY_ROLE,
        ...tenantLabels(tenantId),
      },
      ExposedPorts: Object.fromEntries(
        [EGRESS_PROXY_PORT, ...Array.from({ length: 7 }, (_, i) => 6080 + i), APP_RELAY_PORT].map(
          (port) => [`${port}/tcp`, {}],
        ),
      ),
      // Only the workspace network at create time: API v1.41 (docker-client.ts) rejects a
      // create with several endpoints ("Container cannot be created with multiple network
      // endpoints"; allowed from v1.44). The outbound network is connected before start below.
      NetworkingConfig: {
        EndpointsConfig: {
          [workspaceNetwork]: {
            Aliases: ["egress-proxy"],
            ...(internalIp === undefined ? {} : { IPAMConfig: { IPv4Address: internalIp } }),
          },
        },
      },
      HostConfig: {
        NetworkMode: workspaceNetwork,
        PortBindings: Object.fromEntries(
          [...Array.from({ length: 7 }, (_, i) => 6080 + i), APP_RELAY_PORT].map((port) => [
            `${port}/tcp`,
            [{ HostIp: this.publishHost, HostPort: "" }],
          ]),
        ),
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        PidsLimit: 128,
        ReadonlyRootfs: true,
        Tmpfs: {
          "/run/deskmates-egress": "rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=1000,gid=1000",
        },
        RestartPolicy: { Name: "unless-stopped" },
        // The proxy is the only resolver in the workspace. A host whose resolver answers public
        // names with fake IPs gets every destination denied; EGRESS_PROXY_DNS routes around it.
        ...(this.egressProxyDns === undefined ? {} : { Dns: [...this.egressProxyDns] }),
      },
    };
    const name = proxyName(workspaceId);
    const res = await this.client.request("POST", `/containers/create?name=${name}`, body);
    if (res.status === 404) {
      throw new DeskmatesError("sandbox_unavailable", "egress proxy image is unavailable", {
        reason: "image_missing",
        image: this.egressProxyImage,
      });
    }
    if (res.status === 409) {
      throw this.networkError(workspaceId, "egress proxy already exists; use attach");
    }
    if (res.status !== 201) throw dockerApiError("POST", "/containers/create", res);
    const { Id } = JSON.parse(res.body) as { Id: string };
    try {
      await this.connectNetwork(EGRESS_OUTBOUND_NETWORK, Id);
      await this.start(Id);
      await this.waitForProxyPolicy(Id, policyHash(""));
      await this.replaceProxyPolicy(Id, allowlist, workspaceId, grants);
      return Id;
    } catch (error) {
      await this.removeContainer(Id);
      throw error;
    }
  }

  private async connectNetwork(
    network: string,
    containerId: string,
    endpoint?: { Aliases?: string[]; IPAMConfig?: { IPv4Address: string } },
  ): Promise<void> {
    const path = `/networks/${encodeURIComponent(network)}/connect`;
    const res = await this.client.request("POST", path, {
      Container: containerId,
      ...(endpoint === undefined ? {} : { EndpointConfig: endpoint }),
    });
    if (res.status !== 200) throw dockerApiError("POST", path, res);
  }

  private async disconnectNetwork(network: string, containerId: string): Promise<void> {
    const path = `/networks/${encodeURIComponent(network)}/disconnect`;
    const res = await this.client.request("POST", path, { Container: containerId, Force: false });
    if (res.status !== 200) throw dockerApiError("POST", path, res);
  }

  /**
   * A daemon restart without live-restore, or a host reboot, starts the workspace and its proxy
   * in whatever order and Docker hands out the network's addresses in that order: the proxy
   * that had `.2` comes back as `.3`, and the workspace container, whose `/etc/hosts` pins
   * `egress-proxy` to `.2`, often sits on `.2` itself. The pin cannot change on a running
   * container, so the proxy is moved back instead: the workspace is taken off the network while
   * it holds the pinned address, the proxy is reattached at that address with its alias, and
   * the workspace is reattached with its own aliases. Nothing is recreated, so the browser
   * profile, the files and the open desktop stay as they were.
   */
  private async repinProxy(
    workspaceId: WorkspaceId,
    workspace: ContainerInspect,
    proxy: ContainerInspect,
    pinnedIp: string,
  ): Promise<ContainerInspect> {
    const network = networkName(workspaceId);
    const endpoint = workspace.NetworkSettings.Networks?.[network];
    const displaced = endpoint?.IPAddress === pinnedIp;
    if (displaced) await this.disconnectNetwork(network, workspace.Id);
    await this.disconnectNetwork(network, proxy.Id);
    await this.connectNetwork(network, proxy.Id, {
      Aliases: ["egress-proxy"],
      IPAMConfig: { IPv4Address: pinnedIp },
    });
    if (displaced) {
      // Docker lists the container's own short id among the aliases; it adds that one itself.
      const aliases = (endpoint?.Aliases ?? []).filter((alias) => !workspace.Id.startsWith(alias));
      await this.connectNetwork(
        network,
        workspace.Id,
        aliases.length === 0 ? undefined : { Aliases: aliases },
      );
    }
    return await this.inspect(proxy.Id);
  }

  private async findManagedContainer(
    workspaceId: WorkspaceId,
    role: string,
  ): Promise<ContainerSummary | undefined> {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [
          `${WORKSPACE_LABEL}=${workspaceId}`,
          `${MANAGED_LABEL}=true`,
          `${ROLE_LABEL}=${role}`,
        ],
      }),
    );
    const { json } = await this.client.expect<ContainerSummary[]>(
      "GET",
      `/containers/json?all=true&filters=${filters}`,
    );
    return json.find(
      (candidate) =>
        candidate.Labels?.[WORKSPACE_LABEL] === workspaceId &&
        candidate.Labels?.[MANAGED_LABEL] === "true" &&
        candidate.Labels?.[ROLE_LABEL] === role,
    );
  }

  private async findAndValidateProxy(
    workspaceId: WorkspaceId,
    repairMissing = false,
    repairInternalIp?: string,
    repairTenantId?: string,
  ): Promise<ContainerInspect> {
    let found = await this.findManagedContainer(workspaceId, EGRESS_PROXY_ROLE);
    if (found === undefined && repairMissing) {
      if (repairInternalIp === undefined) {
        throw this.networkError(
          workspaceId,
          "cannot safely repair proxy without its pinned address",
        );
      }
      const id = await this.createProxy(workspaceId, [], repairInternalIp, repairTenantId);
      found = { Id: id, State: "running", Labels: {} };
    }
    if (found === undefined)
      throw this.networkError(workspaceId, "managed egress proxy is missing");
    const proxy = await this.inspect(found.Id);
    const names = Object.keys(proxy.NetworkSettings.Networks ?? {}).sort();
    const expected = [EGRESS_OUTBOUND_NETWORK, networkName(workspaceId)].sort();
    if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) {
      throw this.networkError(workspaceId, "egress proxy network attachments are mismatched");
    }
    const fallbackIp = networkGatewayAddress(await this.inspectNetwork(EGRESS_OUTBOUND_NETWORK));
    if (
      !fallbackIp ||
      envValue(proxy.Config.Env, "DESKMATES_HOST_TARGET") !== this.hostTarget ||
      envValue(proxy.Config.Env, "DESKMATES_HOST_FALLBACK_IP") !== fallbackIp
    ) {
      throw this.networkError(workspaceId, "egress proxy host target is missing or mismatched");
    }
    if (!proxy.State.Running) {
      await this.start(proxy.Id);
      // A stopped container has no network address and no published ports; Docker assigns both
      // at start. Returning the pre-start inspect made `attach` compare an empty address against
      // the workspace's pinned alias and always fail with "address is missing or stale", so any
      // attach that had to start a stopped proxy could not succeed.
      return await this.inspect(proxy.Id);
    }
    return proxy;
  }

  private async assertWorkspaceNetwork(
    workspaceId: WorkspaceId,
    containerId: string,
    inspect: ContainerInspect,
  ): Promise<void> {
    const expected = networkName(workspaceId);
    const names = Object.keys(inspect.NetworkSettings.Networks ?? {});
    if (names.length === 0) {
      const res = await this.client.request(
        "POST",
        `/networks/${encodeURIComponent(expected)}/connect`,
        {
          Container: containerId,
        },
      );
      if (res.status !== 200) throw dockerApiError("POST", `/networks/${expected}/connect`, res);
      return;
    }
    if (
      names.length !== 1 ||
      names[0] !== expected ||
      inspect.HostConfig?.NetworkMode !== expected
    ) {
      throw this.networkError(
        workspaceId,
        "workspace is attached to a legacy or mismatched network",
      );
    }
  }

  private async replaceProxyPolicy(
    proxyId: string,
    allowlist: readonly string[],
    workspaceId: WorkspaceId,
    grants: readonly NetworkGrant[] = [],
  ): Promise<EgressAcknowledgement> {
    const targets = this.privateEgressTargets.filter((entry) => entry.workspaceId === workspaceId);
    const policy = proxyPolicyDocument(allowlist, targets, grants);
    const expectedHash = policyHash(policy);
    // A policy the proxy already acknowledges is left alone: a reload closes every open public
    // connection, and the Gateway reapplies the policy before each use of a cached sandbox (so a
    // proxy that restarted deny-all gets it back). A different policy, a revocation included,
    // still reloads.
    const script =
      '[ "$(cat /run/deskmates-egress/allowlist.sha256 2>/dev/null)" = "$0" ] && { cat >/dev/null; echo unchanged; exit 0; }; ' +
      "umask 077; cat > /run/deskmates-egress/allowlist.tmp && mv -f /run/deskmates-egress/allowlist.tmp /run/deskmates-egress/allowlist && kill -HUP 1; " +
      'i=0; while [ "$i" -lt 100 ]; do [ "$(cat /run/deskmates-egress/allowlist.sha256 2>/dev/null)" = "$0" ] && exit 0; i=$((i+1)); sleep 0.05; done; exit 1';
    const result = await this.runExec(
      proxyId,
      { cmd: ["/bin/sh", "-c", script, expectedHash], stdin: policy, timeoutMs: 10_000 },
      randomUUID(),
    );
    if (result.timedOut || result.exitCode !== 0) {
      throw new DeskmatesError("sandbox_unavailable", "egress policy reload was not acknowledged", {
        reason: "egress_reload_failed",
      });
    }
    return { policyHash: expectedHash, reloaded: result.stdout.trim() !== "unchanged" };
  }

  private async waitForProxyPolicy(proxyId: string, expectedHash: string): Promise<void> {
    const script =
      'i=0; while [ "$i" -lt 100 ]; do [ "$(cat /run/deskmates-egress/allowlist.sha256 2>/dev/null)" = "$0" ] && exit 0; i=$((i+1)); sleep 0.05; done; exit 1';
    const result = await this.runExec(
      proxyId,
      { cmd: ["/bin/sh", "-c", script, expectedHash], timeoutMs: 10_000 },
      randomUUID(),
    );
    if (result.timedOut || result.exitCode !== 0) {
      await this.stopContainer(proxyId);
      throw new DeskmatesError(
        "sandbox_unavailable",
        "egress proxy did not load its initial policy",
        {
          reason: "egress_reload_failed",
        },
      );
    }
  }

  private async stopContainer(id: string): Promise<void> {
    const stop = await this.client.request("POST", `/containers/${id}/stop?t=10`);
    if (![204, 304, 404].includes(stop.status)) {
      throw dockerApiError("POST", `/containers/${id}/stop`, stop);
    }
  }

  private async removeContainer(id: string): Promise<void> {
    await this.stopContainer(id);
    const rm = await this.client.request("DELETE", `/containers/${id}?v=false&force=true`);
    if (![204, 404].includes(rm.status)) throw dockerApiError("DELETE", `/containers/${id}`, rm);
  }

  private async removeNetwork(name: string): Promise<void> {
    const rm = await this.client.request("DELETE", `/networks/${encodeURIComponent(name)}`);
    if (![204, 404].includes(rm.status)) throw dockerApiError("DELETE", `/networks/${name}`, rm);
  }

  private networkError(workspaceId: WorkspaceId, message: string): DeskmatesError {
    return new DeskmatesError("sandbox_unavailable", `workspace ${workspaceId}: ${message}`, {
      reason: "network_mismatch",
      workspaceId,
    });
  }

  private async start(id: string): Promise<void> {
    const res = await this.client.request("POST", `/containers/${id}/start`);
    if (res.status !== 204 && res.status !== 304) {
      throw dockerApiError("POST", `/containers/${id}/start`, res);
    }
  }

  private async restart(id: string): Promise<void> {
    const res = await this.client.request("POST", `/containers/${id}/restart?t=10`);
    if (res.status !== 204) throw dockerApiError("POST", `/containers/${id}/restart`, res);
  }

  /**
   * An image's labels on this daemon; inspect only, never a pull (ADR-0048 decision 11: the
   * Gateway reads the desktop capability before the tools can be enabled).
   */
  async imageLabels(image: string): Promise<Readonly<Record<string, string>>> {
    const path = `/images/${encodeURIComponent(image)}/json`;
    const res = await this.client.request("GET", path);
    if (res.status === 404) {
      throw new DeskmatesError("sandbox_unavailable", `image not found: ${image}`, {
        reason: "image_missing",
        image,
      });
    }
    if (res.status !== 200) throw dockerApiError("GET", path, res);
    const inspect = JSON.parse(res.body) as { Config?: { Labels?: Record<string, string> | null } };
    return inspect.Config?.Labels ?? {};
  }

  /** The content ID an image reference names on this daemon; inspect only, never a pull. */
  private async resolveImageId(image: string): Promise<string> {
    const path = `/images/${encodeURIComponent(image)}/json`;
    const res = await this.client.request("GET", path);
    if (res.status === 404) {
      throw new DeskmatesError("sandbox_unavailable", `image not found: ${image}`, {
        reason: "image_missing",
        image,
      });
    }
    if (res.status !== 200) throw dockerApiError("GET", path, res);
    return (JSON.parse(res.body) as { Id: string }).Id;
  }

  private async inspect(id: string): Promise<ContainerInspect> {
    const { json } = await this.client.expect<ContainerInspect>("GET", `/containers/${id}/json`);
    return json;
  }

  /**
   * Block until the container's HEALTHCHECK reports `healthy`. A container whose image declares
   * no health check (the alpine fixture in T2) is ready the moment it runs, so this returns after
   * a single inspect. On timeout the caller gets `sandbox_unavailable` / `reason: "not_ready"`
   * rather than a handle to a container nothing can use yet.
   */
  private async waitUntilReady(id: string, workspaceId: WorkspaceId): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    let health = (await this.inspect(id)).State.Health;
    if (health === undefined) return;
    while (health.Status !== "healthy") {
      if (Date.now() >= deadline) {
        throw new DeskmatesError(
          "sandbox_unavailable",
          `workspace ${workspaceId}: container not healthy after ${this.readyTimeoutMs}ms ` +
            `(health=${health.Status})`,
          { reason: "not_ready", workspaceId, health: health.Status },
        );
      }
      await sleep(READY_POLL_MS);
      health = (await this.inspect(id)).State.Health;
      if (health === undefined) return;
    }
  }

  private async handleFor(workspaceId: WorkspaceId, id: string): Promise<SandboxHandle> {
    const json = await this.inspect(id);
    const handle: SandboxHandle = {
      workspaceId,
      providerRef: json.Id,
      // M0: no sidecar supervisor; the Gateway starts `deskmates-sidecar run` through exec.
      sidecarAddress: `docker-exec://${json.Id}`,
    };
    const proxy = await this.findManagedContainer(workspaceId, EGRESS_PROXY_ROLE);
    const proxyInspect = proxy ? await this.inspect(proxy.Id) : undefined;
    const ports = proxyInspect?.NetworkSettings.Ports;
    const address = (port: number): string | undefined => {
      const binding = ports?.[`${port}/tcp`]?.[0];
      if (!binding?.HostPort) return undefined;
      if (binding.HostIp !== "127.0.0.1" && binding.HostIp !== "::1")
        throw this.networkError(workspaceId, "screen port must be published on loopback");
      return `${binding.HostIp === "::1" ? "[::1]" : binding.HostIp}:${binding.HostPort}`;
    };
    // A proxy from before ADR-0035 has neither; its publications then report unavailable.
    const appRelayAddress = address(APP_RELAY_PORT);
    const appRelayKey = envValue(proxyInspect?.Config.Env, APP_RELAY_KEY_ENV);
    if (appRelayAddress && appRelayKey && /^[0-9a-f]{32}$/.test(appRelayKey)) {
      handle.appRelayAddress = appRelayAddress;
      handle.appRelayKey = appRelayKey;
    }
    const novncAddress = address(NOVNC_CONTAINER_PORT);
    if (novncAddress && envValue(json.Config.Env, VNC_PASSWORD_ENV))
      handle.novncAddress = novncAddress;
    if (handle.novncAddress) {
      const password = this.vncPasswordFromInspect(workspaceId, json);
      if (password) handle.novncPassword = password;
      const view = envValue(json.Config.Env, "DESKMATES_VNC_VIEW_PASSWORD");
      if (view && /^[0-9a-f]{8}$/i.test(view)) handle.novncViewPassword = view;
      if (
        envValue(json.Config.Env, "DESKMATES_DESKTOP_MODE") === "shared-monitors-v1" &&
        json.Config.Labels?.["deskmates.desktop.mode"] === "shared-monitors-v1"
      ) {
        const addresses = Array.from({ length: 6 }, (_, i) => address(6081 + i));
        if (addresses.every((value): value is string => value !== undefined))
          handle.botScreenAddresses = addresses;
      }
    }
    return handle;
  }

  private vncPasswordFromInspect(
    workspaceId: WorkspaceId,
    inspect: ContainerInspect,
  ): string | undefined {
    const value = envValue(inspect.Config.Env, VNC_PASSWORD_ENV);
    if (value === undefined && !inspect.NetworkSettings.Ports?.[`${NOVNC_CONTAINER_PORT}/tcp`])
      return undefined;

    if (value === undefined || !/^[0-9a-fA-F]{8}$/.test(value)) {
      throw new DeskmatesError(
        "sandbox_unavailable",
        `workspace ${workspaceId}: noVNC password is missing or invalid`,
        { reason: "vnc_password_missing", workspaceId },
      );
    }
    return value;
  }

  private async runExec(
    containerId: string,
    req: ExecRequest,
    marker: string,
  ): Promise<ExecResult> {
    const env = [`${EXEC_MARKER_ENV}=${marker}`];
    for (const [k, v] of Object.entries(req.env ?? {})) env.push(`${k}=${v}`);
    const { json: created } = await this.client.expect<{ Id: string }>(
      "POST",
      `/containers/${containerId}/exec`,
      {
        AttachStdin: req.stdin !== undefined,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
        Cmd: [...req.cmd],
        Env: env,
        ...(req.cwd === undefined ? {} : { WorkingDir: req.cwd }),
      },
    );
    const execId = created.Id;
    const { socket, head } = await this.client.hijack(`/exec/${execId}/start`, {
      Detach: false,
      Tty: false,
    });
    const demux = new DockerStreamDemuxer();
    if (head.length > 0) demux.push(head);

    let streamError: Error | undefined;
    const timedOut = await new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (t: boolean) => {
        if (done) return;
        done = true;
        if (timer !== undefined) clearTimeout(timer);
        req.signal?.removeEventListener("abort", onAbort);
        resolve(t);
      };
      // An abort is a deadline the caller moved up: same partial output, same kill below.
      const onAbort = () => {
        socket.destroy();
        finish(true);
      };
      const timer =
        req.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              socket.destroy();
              finish(true);
            }, req.timeoutMs);
      if (req.signal?.aborted) onAbort();
      else req.signal?.addEventListener("abort", onAbort, { once: true });
      socket.on("data", (chunk: Buffer) => demux.push(chunk));
      socket.on("end", () => finish(false));
      socket.on("close", () => finish(false));
      socket.on("error", (e: Error) => {
        // Remembered, not swallowed: the exec may still report a real exit code afterwards and
        // the caller would take the truncated output for the whole answer.
        streamError = e;
        finish(false);
      });
      if (req.stdin !== undefined) {
        socket.write(req.stdin);
        // Half-close: the daemon sees EOF on the process's stdin; stdout/stderr keep flowing.
        socket.end();
      }
    });

    const out = demux.result();
    // A timeout is the one case where partial output is the answer: the caller asked for it and
    // gets timedOut: true with whatever arrived.
    if (timedOut) return { ...out, exitCode: -1, timedOut: true };
    // Otherwise the stream must have ended cleanly on a frame boundary. A socket error, or bytes
    // left over that do not form a complete frame, means output was lost; `waitExit` would still
    // report the process's real exit code and the truncation would pass for success.
    if (streamError !== undefined || demux.pendingBytes > 0) {
      throw new DeskmatesError(
        "sandbox_unavailable",
        `exec ${execId}: output stream ended early (${
          streamError?.message ?? `${demux.pendingBytes} bytes of a partial frame`
        }); the result would be truncated`,
        {
          reason: "stream_error",
          execId,
          pendingBytes: demux.pendingBytes,
          errno: (streamError as NodeJS.ErrnoException | undefined)?.code ?? null,
        },
      );
    }
    const exitCode = await this.waitExit(execId);
    return { ...out, exitCode, timedOut: false };
  }

  private async waitExit(execId: string): Promise<number> {
    // The stream closes a moment before the daemon records the exit code.
    for (let i = 0; i < 100; i += 1) {
      const { json } = await this.client.expect<ExecInspect>("GET", `/exec/${execId}/json`);
      if (!json.Running && json.ExitCode !== null) return json.ExitCode;
      await sleep(50);
    }
    throw new DeskmatesError("sandbox_unavailable", `exec ${execId}: exit code not reported`);
  }

  /** Kill every process in the container whose environment carries the exec marker. */
  private async killByMarker(containerId: string, marker: string): Promise<void> {
    await this.killByEnv(containerId, EXEC_MARKER_ENV, marker);
  }

  /** Kill every process in the container whose environment has `key=value`. */
  private async killByEnv(containerId: string, key: string, value: string): Promise<void> {
    // tr + grep -x rather than grep -z: busybox grep (alpine) has no -z.
    const script =
      "if test -f /usr/local/lib/deskmates/run-supervisor.py; then " +
      'exec python3 /usr/local/lib/deskmates/run-supervisor.py stop "$0" "$1"; fi; ' +
      'for p in /proc/[0-9]*; do tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qx "$0=$1" ' +
      '&& kill -9 "${p#/proc/}" 2>/dev/null; done; exit 0';
    try {
      const result = await this.runExec(
        containerId,
        { cmd: ["/bin/sh", "-c", script, key, value], timeoutMs: 10_000 },
        randomUUID(),
      );
      if (result.timedOut || result.exitCode !== 0)
        throw new DeskmatesError("sandbox_unavailable", "run descendant cleanup not confirmed", {
          reason: "cleanup_failed",
          stderr: result.stderr,
        });
    } catch (error) {
      // A disappeared container has no surviving descendants; other cleanup errors matter.
      const inspect = await this.client.request("GET", `/containers/${containerId}/json`);
      if (inspect.status !== 404) throw error;
    }
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^[^A-Za-z0-9]+/, "") || "ws";
}

/** Deterministic container name; the label is the source of truth, the name is for humans. */
export function containerName(workspaceId: WorkspaceId): string {
  return `deskmates-ws-${sanitize(workspaceId)}`;
}

/** Deterministic internal network name; labels remain the ownership source of truth. */
export function networkName(workspaceId: WorkspaceId): string {
  return `deskmates-net-${sanitize(workspaceId)}`;
}

export function proxyName(workspaceId: WorkspaceId): string {
  return `deskmates-egress-${sanitize(workspaceId)}`;
}

function envValue(env: readonly string[] | undefined, key: string): string | undefined {
  const prefix = `${key}=`;
  const entry = env?.find((value) => value.startsWith(prefix));
  return entry?.slice(prefix.length);
}

/**
 * The bridge address of a user-defined network: IPAM's `Gateway` when the daemon reports one,
 * else the first host address of its IPv4 subnet, which is what Docker assigns the bridge.
 */
export function networkGatewayAddress(network: NetworkInspect | undefined): string | undefined {
  for (const cfg of network?.IPAM?.Config ?? []) {
    if (cfg.Gateway) return cfg.Gateway.split("/")[0];
    const subnet = cfg.Subnet;
    const m = subnet === undefined ? null : /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(subnet);
    if (!m) continue;
    const octets = m.slice(1, 5).map(Number);
    if (octets.some((o) => o > 255)) continue;
    const bits = Number(m[5]);
    if (bits > 30) continue;
    const base = octets.reduce((acc, o) => ((acc << 8) | o) >>> 0, 0);
    const network = (base & (bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0)) >>> 0;
    const first = (network + 1) >>> 0;
    return [first >>> 24, (first >>> 16) & 255, (first >>> 8) & 255, first & 255].join(".");
  }
  return undefined;
}

function proxyIpFromExtraHosts(extraHosts: readonly string[] | undefined): string | undefined {
  const prefix = "egress-proxy:";
  return extraHosts?.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function validateVncPassword(spec: SandboxSpec): void {
  if (!spec.ports.includes(NOVNC_CONTAINER_PORT)) return;
  const value = spec.env[VNC_PASSWORD_ENV];
  if (value === undefined || !/^[0-9a-fA-F]{8}$/.test(value)) {
    throw new DeskmatesError(
      "validation",
      "a published noVNC workspace requires an 8-character hexadecimal password",
      { reason: "vnc_password_invalid" },
    );
  }
}

function canonicalAllowlist(allowlist: readonly string[]): string {
  const values = [...new Set(allowlist.map((value) => value.toLowerCase()))].sort();
  if (values.some((value) => !isEgressPattern(value))) {
    throw new DeskmatesError("validation", "egress allowlist contains an invalid hostname pattern");
  }
  return values.length === 0 ? "" : `${values.join("\n")}\n`;
}

/**
 * The bytes the proxy loads (images/egress/egress-policy.mjs `parsePolicyDocument`). The text
 * format stays exactly as before without private targets or grants, and version 1 without
 * grants, so an upgrade changes no hash and reloads no proxy (ADR-0027 amendment 1 decision 6).
 * One document and one hash cover every layer; no stale grant survives an acknowledged revoke.
 */
export function proxyPolicyDocument(
  allowlist: readonly string[],
  targets: readonly PrivateEgressTarget[],
  grants: readonly NetworkGrant[],
): string {
  const names = canonicalAllowlist(allowlist);
  if (targets.length === 0 && grants.length === 0) return names;
  const list = names.trim().split("\n").filter(Boolean);
  if (grants.length === 0)
    return JSON.stringify({ version: 1, allowlist: list, privateTargets: targets });
  return JSON.stringify({ version: 2, allowlist: list, privateTargets: targets, grants });
}

function policyHash(policy: string): string {
  return createHash("sha256").update(policy).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
