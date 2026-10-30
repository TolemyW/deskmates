// The sandbox provider, workspace and egress images, egress resolution and private targets,
// workspace container limits and the workspace file download cap.

import { isIP } from "node:net";
import {
  DeskmatesError,
  type PrivateEgressTarget,
  WORKSPACE_FILE_MAX_BYTES_DEFAULT,
  parseIpv4Cidr,
  parsePrivateEgressTargets,
} from "@deskmates/contracts";
import { type Env, optionalCores, optionalInt, optionalLimit } from "./env.js";

/**
 * Memory ceiling for one workspace container. A workspace holds a Chromium, an X server and one
 * sidecar per live run at roughly 1 GiB per SDK session (AGENTS.md open decision "workspace
 * sizing"), so an unbounded container can take the host down with it. Nothing caps how many
 * runs a workspace has at once (ADR-0022 amendment 5), so this and `WORKSPACE_CPU_LIMIT` are what
 * bound them together. 8 GiB holds the browser and several live sessions (issue #69: 4 GiB did
 * not fit four; the 2026-10-11 campaigns peaked at about 2 to 3 GiB per workspace under a 12 GiB
 * cap); tune per deployment.
 */
export const WORKSPACE_MEMORY_LIMIT_MB_DEFAULT = 8192;
/** CPU cores one workspace container may use together (ADR-0022 amendment 5); 0 means no limit. */
export const WORKSPACE_CPU_LIMIT_DEFAULT = 4;

export interface SandboxConfig {
  sandboxProvider: "docker" | "desktop-vm";
  workspaceImage: string;
  /** Network egress proxy image; consumed by the Docker provider. */
  egressImage: string;
  /**
   * `EGRESS_PROXY_DNS`: DNS servers of the egress proxy container (ADR-0010 decision 4).
   * Undefined keeps Docker's embedded resolver. Consumed by the Docker provider.
   */
  egressProxyDns?: string[];
  /**
   * `EGRESS_PROXY_DOH_URL`: JSON DNS-over-HTTPS endpoint (https, IP-literal host) the egress
   * proxy resolves names through (ADR-0010 decision 4a). Undefined keeps port-53 DNS. When set,
   * it wins over `egressProxyDns` for the proxy's lookups. Consumed by the Docker provider.
   */
  egressProxyDohUrl?: string;
  /** Deployment-owned exact private HTTPS grants, filtered by workspace (ADR-0027). */
  privateEgressTargets?: PrivateEgressTarget[];
  /**
   * `NETWORK_LAN_CIDRS`: IPv4 CIDRs of the LAN the host reaches, checked for overlap with the
   * daemon's Docker networks (ADR-0027 amendment 2 decision 15). Advisory; never enforced.
   */
  lanCidrs?: string[];
  /**
   * Memory ceiling of a workspace container, in MiB; recorded in `runs.config_json`.
   */
  workspaceMemoryLimitMb: number;
  /**
   * CPU cores of a workspace container, fractions allowed, 0 for no limit; recorded in
   * `runs.config_json`. Omitted means `WORKSPACE_CPU_LIMIT_DEFAULT`.
   */
  workspaceCpuLimit?: number;
  /**
   * Largest workspace file the operator download route returns (`FILE_DOWNLOAD_MAX_BYTES`,
   * ADR-0014 A3 decision 17; default `WORKSPACE_FILE_MAX_BYTES_DEFAULT`, 1 GiB). Not a run knob: no
   * run is involved. Optional so embedders that predate it keep compiling.
   */
  fileDownloadMaxBytes?: number;
  /**
   * Disclosed per-workspace upload quota in bytes (`FILE_UPLOAD_WORKSPACE_QUOTA_BYTES`, ADR-0014
   * A5 decision 30, proposed). 0 or unset: no quota. There is no per-file upload cap.
   */
  fileUploadWorkspaceQuotaBytes?: number;
}

/** A typo in `EGRESS_PRIVATE_TARGETS` is a startup error that names the key, like `MODEL_PRICES`. */
function privateEgressTargets(env: Env): Pick<SandboxConfig, "privateEgressTargets"> {
  const raw = env.EGRESS_PRIVATE_TARGETS?.trim();
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new DeskmatesError(
      "validation",
      `EGRESS_PRIVATE_TARGETS is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { privateEgressTargets: parsePrivateEgressTargets(parsed) };
}

function lanCidrs(env: Env): Pick<SandboxConfig, "lanCidrs"> {
  const raw = env.NETWORK_LAN_CIDRS?.trim();
  if (!raw) return {};
  const cidrs = raw.split(/[\s,]+/).filter(Boolean);
  const invalid = cidrs.filter((cidr) => !/\/[0-9]{1,2}$/.test(cidr) || !parseIpv4Cidr(cidr));
  if (invalid.length > 0)
    throw new DeskmatesError("validation", "NETWORK_LAN_CIDRS must list IPv4 CIDRs", { invalid });
  return { lanCidrs: cidrs };
}

/** `SANDBOX_PROVIDER`, checked before anything else is read. */
export function readSandboxProvider(env: Env): SandboxConfig["sandboxProvider"] {
  const provider = env.SANDBOX_PROVIDER?.trim() || "docker";
  if (provider !== "docker" && provider !== "desktop-vm") {
    throw new DeskmatesError("validation", "SANDBOX_PROVIDER must be docker or desktop-vm", {
      raw: provider,
    });
  }
  return provider;
}

export function readSandboxConfig(env: Env): SandboxConfig {
  return {
    sandboxProvider: readSandboxProvider(env),
    workspaceImage: env.WORKSPACE_IMAGE?.trim() || "deskmates/workspace:dev",
    egressImage: env.EGRESS_PROXY_IMAGE?.trim() || "deskmates/egress-proxy:dev",
    ...egressProxyDns(env),
    ...egressProxyDohUrl(env),
    ...privateEgressTargets(env),
    ...lanCidrs(env),
    workspaceMemoryLimitMb: optionalInt(
      env,
      "WORKSPACE_MEMORY_LIMIT_MB",
      WORKSPACE_MEMORY_LIMIT_MB_DEFAULT,
    ),
    workspaceCpuLimit: optionalCores(env, "WORKSPACE_CPU_LIMIT", WORKSPACE_CPU_LIMIT_DEFAULT),
    fileDownloadMaxBytes: optionalInt(
      env,
      "FILE_DOWNLOAD_MAX_BYTES",
      WORKSPACE_FILE_MAX_BYTES_DEFAULT,
    ),
    fileUploadWorkspaceQuotaBytes: optionalLimit(env, "FILE_UPLOAD_WORKSPACE_QUOTA_BYTES", 0),
  };
}

/**
 * `EGRESS_PROXY_DNS`, comma-separated IPv4/IPv6 addresses. Unset or empty means Docker's embedded
 * resolver. Any entry that is not an IP address stops startup: a proxy handed a resolver Docker
 * cannot use would deny every destination with nothing to say why (ADR-0010 decision 4).
 */
function egressProxyDns(env: Env): { egressProxyDns?: string[] } {
  const raw = env.EGRESS_PROXY_DNS?.trim();
  if (raw === undefined || raw === "") return {};
  const servers = raw.split(",").map((entry) => entry.trim());
  const bad = servers.find((entry) => isIP(entry) === 0);
  if (bad !== undefined) {
    throw new DeskmatesError(
      "validation",
      `EGRESS_PROXY_DNS must be comma-separated IP addresses; ${JSON.stringify(bad)} is not one`,
      { key: "EGRESS_PROXY_DNS", raw },
    );
  }
  return { egressProxyDns: servers };
}

/**
 * `EGRESS_PROXY_DOH_URL`, an `https://` URL whose host is an IP literal. A hostname is refused:
 * resolving the resolver would itself go through the port-53 path DoH exists to avoid. Unset or
 * empty keeps port-53 DNS. Anything else stops startup (ADR-0010 decision 4a).
 */
function egressProxyDohUrl(env: Env): { egressProxyDohUrl?: string } {
  const raw = env.EGRESS_PROXY_DOH_URL?.trim();
  if (raw === undefined || raw === "") return {};
  const fail = (why: string): never => {
    throw new DeskmatesError("validation", `EGRESS_PROXY_DOH_URL ${why}`, {
      key: "EGRESS_PROXY_DOH_URL",
      raw,
    });
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("is not a URL");
  }
  if (url.protocol !== "https:") fail("must use https");
  if (url.username !== "" || url.password !== "") fail("must not carry credentials");
  if (isIP(url.hostname.replace(/^\[|\]$/g, "")) === 0) fail("host must be an IP literal");
  return { egressProxyDohUrl: raw };
}
