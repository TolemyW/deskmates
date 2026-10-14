// The workspace sandbox registry, built for `buildContext` (issue #53) with the container limits
// from the Gateway config.

import type { SandboxProvider } from "@deskmates/contracts";
import { type GatewayConfig, WORKSPACE_CPU_LIMIT_DEFAULT } from "../config.js";
import type { GatewayDb } from "../db/open.js";
import { NetworkProfileStore } from "../network/network-profile-store.js";
import type { Ownership } from "../tenancy/ownership.js";
import { SandboxRegistry } from "./sandboxes.js";
import type { WorkspaceStore } from "./workspaces.js";

export interface SandboxModuleDeps {
  provider: SandboxProvider;
  config: GatewayConfig;
  workspaces: WorkspaceStore;
  ownership: Ownership;
  /** Durable network-profile grants every policy push carries (ADR-0027 amendment 1). */
  db: GatewayDb;
  /** Operational log for lifecycle events outside a run, e.g. a stale sandbox recreated. */
  log: (msg: string, data: Record<string, unknown>) => void;
}

export function createSandboxRegistry(deps: SandboxModuleDeps): SandboxRegistry {
  const { config, workspaces, ownership } = deps;
  const workspaceCpuLimit = config.workspaceCpuLimit ?? WORKSPACE_CPU_LIMIT_DEFAULT;
  const profiles = new NetworkProfileStore(deps.db);
  return new SandboxRegistry(
    deps.provider,
    config.workspaceImage,
    {
      memoryLimitBytes: config.workspaceMemoryLimitMb * 1024 * 1024,
      ...(workspaceCpuLimit > 0 ? { cpuLimit: workspaceCpuLimit } : {}),
    },
    (id) => workspaces.mustGet(id),
    deps.log,
    (id) => ownership.tenantOf("workspace", id),
    (id, requirements, options) =>
      workspaces.recordRestorationRequirements(id, requirements, options),
    (id) => profiles.grantsFor(id),
  );
}
