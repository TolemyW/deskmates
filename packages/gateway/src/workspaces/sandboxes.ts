// Maps a workspace row to its live sandbox handle: attach if the container already exists and runs
// the configured image, create it otherwise. One container per workspace (ADR-0004); nothing
// model-related in the spec.

import { randomBytes } from "node:crypto";
import {
  NOVNC_CONTAINER_PORT,
  type NetworkGrant,
  type SandboxHandle,
  type SandboxImageDrift,
  type SandboxProvider,
  type SandboxRestorationRequirement,
  type SandboxSpec,
  type SandboxVolatilePrerequisite,
  type Workspace,
  type WorkspaceId,
} from "@deskmates/contracts";

export class SandboxRegistry {
  private readonly policies = new Map<string, Promise<unknown>>();

  private async exclusive<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.policies.get(workspaceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    this.policies.set(workspaceId, next);
    try {
      return await next;
    } finally {
      if (this.policies.get(workspaceId) === next) this.policies.delete(workspaceId);
    }
  }

  /** The callback's peek avoids recursively acquiring the same lifecycle gate. */
  withPolicyUpdate<T>(
    workspaceId: WorkspaceId,
    operation: (peek: () => Promise<SandboxHandle | undefined>) => Promise<T>,
  ): Promise<T> {
    return this.exclusive(workspaceId, () => operation(() => this.peekUnlocked(workspaceId)));
  }

  private readonly handles = new Map<string, Promise<SandboxHandle>>();

  constructor(
    private readonly provider: SandboxProvider,
    private readonly image: string,
    /**
     * The container's resource ceilings: `WORKSPACE_MEMORY_LIMIT_MB` in bytes and
     * `WORKSPACE_CPU_LIMIT` in cores (absent: no CPU limit). They bound all of a workspace's runs
     * together; the scheduler does not cap how many run at once (ADR-0022 amendment 5).
     */
    private readonly limits: { memoryLimitBytes: number; cpuLimit?: number },
    private readonly latestWorkspace: (id: WorkspaceId) => Workspace,
    /** One line per sandbox recreated because it ran a stale image. */
    private readonly log: (msg: string, data: Record<string, unknown>) => void = () => {},
    /** The workspace's tenant, labelled on and checked against its sandbox (DOCKER-01). */
    private readonly tenantOf: (id: WorkspaceId) => string | undefined = () => undefined,
    private readonly recordRestoration: (
      id: WorkspaceId,
      requirements: readonly SandboxRestorationRequirement[],
      options?: { inspectionComplete?: boolean },
    ) => void = () => {},
    /** The workspace's network-profile grants, published with its allowlist (ADR-0027 amd. 1). */
    private readonly grantsOf: (id: WorkspaceId) => readonly NetworkGrant[] = () => [],
  ) {}

  ensure(workspace: Workspace): Promise<SandboxHandle> {
    return this.exclusive(workspace.id, () =>
      this.ensureUnlocked(this.latestWorkspace(workspace.id)),
    );
  }

  private ensureUnlocked(workspace: Workspace): Promise<SandboxHandle> {
    const cached = this.handles.get(workspace.id);
    if (cached) return this.reapplyPolicy(workspace, cached);
    const pending = this.open(workspace).catch((err) => {
      this.handles.delete(workspace.id);
      throw err;
    });
    this.handles.set(workspace.id, pending);
    return pending;
  }

  /**
   * A cached handle may front an egress proxy that restarted since it was opened: every proxy
   * start is deny-all and waits for the Gateway to push the policy (images/egress). Push the
   * current allowlist before each use; it is idempotent and cheap. If the push fails the sandbox
   * is not what the cache says, so drop it and open again.
   */
  private async reapplyPolicy(
    workspace: Workspace,
    cached: Promise<SandboxHandle>,
  ): Promise<SandboxHandle> {
    const handle = await cached;
    try {
      await this.provider.updateEgress(
        handle,
        workspace.egressAllowlist,
        this.grantsOf(workspace.id),
      );
      return handle;
    } catch (err) {
      this.log("reopening workspace sandbox: reapplying its egress policy failed", {
        workspaceId: workspace.id,
        error: String(err),
      });
      this.handles.delete(workspace.id);
      return this.ensureUnlocked(workspace);
    }
  }

  /**
   * The workspace's handle without starting anything: the cached one, else whatever `attach`
   * finds. The takeover UI asks for the noVNC address of a workspace that may have no container
   * yet, and reading a URL must never be what creates one.
   */
  peek(workspaceId: WorkspaceId): Promise<SandboxHandle | undefined> {
    return this.exclusive(workspaceId, () => this.peekUnlocked(workspaceId));
  }

  private async peekUnlocked(workspaceId: WorkspaceId): Promise<SandboxHandle | undefined> {
    const cached = this.handles.get(workspaceId);
    if (cached) return cached;
    const attached = await this.provider.attach(workspaceId, this.tenantOf(workspaceId));
    return this.handles.get(workspaceId) ?? attached;
  }

  replacementPreflight(workspaceId: WorkspaceId): Promise<readonly SandboxVolatilePrerequisite[]> {
    return this.exclusive(workspaceId, async () => {
      const spec = this.spec(this.latestWorkspace(workspaceId));
      await this.provider.preflight(spec);
      return this.provider.inspectVolatilePrerequisites?.(spec) ?? [];
    });
  }

  /** Records the notices and returns them, for a caller reporting this operation's findings. */
  private recordPrerequisites(
    workspaceId: WorkspaceId,
    prerequisites: readonly SandboxVolatilePrerequisite[],
    status: SandboxRestorationRequirement["status"],
    options: { inspectionComplete?: boolean } = {},
  ): SandboxRestorationRequirement[] {
    const requirements = prerequisites.map((item) => ({ ...item, status }));
    if (requirements.length || options.inspectionComplete)
      this.recordRestoration(workspaceId, requirements, options);
    return requirements;
  }

  /**
   * Destroy and recreate. Resolves with the new handle and the restoration notices this restart
   * produced (not ones stored by earlier operations).
   */
  restart(workspaceId: WorkspaceId): Promise<{
    handle: SandboxHandle;
    restorationRequirements: SandboxRestorationRequirement[];
  }> {
    return this.exclusive(workspaceId, async () => {
      const workspace = this.latestWorkspace(workspaceId);
      const spec = this.spec(workspace);
      await this.provider.preflight(spec);
      const cached = this.handles.get(workspaceId);
      const cachedHandle = cached ? await cached : undefined;
      const prerequisites =
        (await this.provider.inspectVolatilePrerequisites?.(spec, cachedHandle?.providerRef)) ?? [];
      let findings = this.recordPrerequisites(workspaceId, prerequisites, "at_risk", {
        inspectionComplete: true,
      });
      const existing = await this.peekUnlocked(workspaceId);
      if (existing) {
        try {
          await this.provider.destroy(existing);
        } catch (err) {
          this.recordPrerequisites(workspaceId, prerequisites, "replacement_outcome_unknown");
          throw err;
        }
        findings = this.recordPrerequisites(workspaceId, prerequisites, "restoration_required");
      }
      this.forget(workspaceId);
      const pending = this.provider.create(spec).catch((err) => {
        this.handles.delete(workspaceId);
        throw err;
      });
      this.handles.set(workspaceId, pending);
      return { handle: await pending, restorationRequirements: findings };
    });
  }

  /** Archive hard-stop: remove runtime pieces but preserve the named volumes. */
  stop(workspaceId: WorkspaceId): Promise<void> {
    return this.exclusive(workspaceId, async () => {
      const existing = await this.peekUnlocked(workspaceId);
      if (existing) await this.provider.destroy(existing);
      this.forget(workspaceId);
    });
  }

  /** Trash-only final removal, including the provider's exact managed named volumes. */
  permanentlyDelete(workspaceId: WorkspaceId): Promise<void> {
    return this.exclusive(workspaceId, async () => {
      await this.provider.permanentlyDelete(workspaceId, this.tenantOf(workspaceId));
      this.forget(workspaceId);
    });
  }

  forget(workspaceId: string): void {
    this.handles.delete(workspaceId);
  }

  /**
   * Attach or create, replacing a sandbox that runs a stale image first.
   *
   * Only reached when this process caches no handle for the workspace: the first use after a
   * Gateway start, after `forget` (the sandbox had gone) or inside `restart` (already
   * destroyed). A run of this process always holds a cached handle, and at startup `reconcile`
   * fails every run a previous process left live, so no run of this Gateway uses a sandbox that
   * gets removed here. `peek` never comes through here: a status or takeover lookup attaches
   * whatever exists and never recreates.
   *
   * After an upgrade changes `WORKSPACE_IMAGE` (or the provider's infrastructure images), the
   * provider removes the old containers and keeps their named volumes; the create below then
   * builds the sandbox exactly like a fresh one: the current allowlist, new screen credentials.
   * A configured image that is not present fails closed before anything is removed.
   */
  private async open(workspace: Workspace): Promise<SandboxHandle> {
    const spec = this.spec(workspace);
    // The replacement preflight guards only destructive or creating paths: a stale-image
    // removal (inside the provider, before it removes anything) and a create. A healthy current
    // sandbox is reattached without it, so legacy volume labels or slow change metadata never
    // block a plain reattach after a Gateway restart.
    let prerequisites: readonly SandboxVolatilePrerequisite[] = [];
    let preflighted = false;
    let drift: readonly SandboxImageDrift[];
    try {
      drift = await this.provider.removeStaleSandbox(workspace.id, this.image, async () => {
        await this.provider.preflight(spec);
        preflighted = true;
        prerequisites = (await this.provider.inspectVolatilePrerequisites?.(spec)) ?? [];
        this.recordPrerequisites(workspace.id, prerequisites, "at_risk", {
          inspectionComplete: true,
        });
        if (prerequisites.length)
          this.log("workspace recreation may discard temporary access prerequisites", {
            workspaceId: workspace.id,
            prerequisites,
          });
      });
    } catch (err) {
      this.recordPrerequisites(workspace.id, prerequisites, "replacement_outcome_unknown");
      throw err;
    }
    if (drift.length > 0) {
      this.recordPrerequisites(workspace.id, prerequisites, "restoration_required");
      this.log("recreating workspace sandbox: it ran a stale image", {
        workspaceId: workspace.id,
        drift,
      });
    }
    const tenantId = this.tenantOf(workspace.id);
    const existing = await this.provider.attach(workspace.id, tenantId);
    if (existing) {
      await this.provider.updateEgress(
        existing,
        workspace.egressAllowlist,
        this.grantsOf(workspace.id),
      );
      return existing;
    }
    if (!preflighted) await this.provider.preflight(spec);
    return this.provider.create(spec);
  }

  private spec(workspace: Workspace): SandboxSpec {
    const tenantId = this.tenantOf(workspace.id);
    const controlPassword = randomBytes(4).toString("hex");
    let viewPassword = randomBytes(4).toString("hex");
    while (viewPassword === controlPassword) viewPassword = randomBytes(4).toString("hex");
    return {
      workspaceId: workspace.id,
      ...(tenantId !== undefined ? { tenantId } : {}),
      image: this.image,
      egressAllowlist: workspace.egressAllowlist,
      egressGrants: this.grantsOf(workspace.id),
      // The provider enforces the allowlist through the workspace's isolated egress proxy.
      // Keep the environment copy for image compatibility; live policy edits update the proxy.
      env: {
        DESKMATES_EGRESS_ALLOWLIST: workspace.egressAllowlist.join(","),
        DESKMATES_VNC_PASSWORD: controlPassword,
        DESKMATES_VNC_VIEW_PASSWORD: viewPassword,
        DESKMATES_DESKTOP_MODE: "shared-monitors-v1",
      },
      volumes: {
        "/profile": `deskmates-${workspace.id}-profile`,
        "/work": `deskmates-${workspace.id}-work`,
        "/home": `deskmates-${workspace.id}-home`,
      },
      // noVNC is the takeover screen: the provider publishes it on the host's loopback and
      // reports the address on the handle, which is what the takeover UI opens (design §3.3).
      ports: [NOVNC_CONTAINER_PORT],
      memoryLimitBytes: this.limits.memoryLimitBytes,
      ...(this.limits.cpuLimit === undefined ? {} : { cpuLimit: this.limits.cpuLimit }),
    };
  }
}
