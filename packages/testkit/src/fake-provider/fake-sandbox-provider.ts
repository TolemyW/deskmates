// In-process SandboxProvider for T0/T1 tests (test strategy §3.2). Nothing here touches Docker.
// Gateway tests script "what the sidecar does" by registering an exec handler per command, and
// inject faults to prove the harness degrades in an orderly way (test strategy §5).
//
// Observable behaviour mirrors `packages/sandbox-docker/src/docker-provider.ts`, so a Gateway test
// that passes here means the same thing against a real container:
//   - `exec` rejects an empty `cmd` with a `validation` DeskmatesError;
//   - `exec` applies a timeout only when the request carries one, and a timed-out exec returns the
//     output produced before the deadline with `exitCode: -1, timedOut: true`;
//   - `injectEnv` rewrites the whole env file, so a later call drops the earlier keys;
//   - `create` for a workspace that already has a container fails with `sandbox_unavailable` and
//     `details.reason = "already_exists"`.

import {
  type AddressPool,
  DeskmatesError,
  type ExecRequest,
  type ExecResult,
  type HostResource,
  type HostResourceInventory,
  type HostResourceTarget,
  type NetworkGrant,
  type SandboxHandle,
  type SandboxImageDrift,
  type SandboxNetworkSubnet,
  type SandboxProvider,
  type SandboxSnapshot,
  type SandboxSpec,
  type WorkspaceId,
} from "@deskmates/contracts";

/** What an exec handler sees: the request plus the environment the process would observe. */
export interface ExecContext {
  handle: SandboxHandle;
  spec: SandboxSpec;
  /** `spec.env`, then everything delivered via `injectEnv`, then `req.env`; later wins. */
  env: Readonly<Record<string, string>>;
  /**
   * Emit output the way a real process writes to the stream: it is what a timed-out exec returns,
   * as DockerProvider returns whatever the hijacked stream carried before the deadline. When the
   * handler completes, its return value wins for any stream it sets.
   */
  writeStdout: (chunk: string) => void;
  writeStderr: (chunk: string) => void;
}

/** A handler may return a full result, a partial one (defaults filled in), or just stdout. */
export type ExecHandlerResult = Partial<ExecResult> | string | undefined;

export type ExecHandler = (
  req: ExecRequest,
  ctx: ExecContext,
) => ExecHandlerResult | Promise<ExecHandlerResult>;

/** One exec as recorded by the provider, with the environment it ran under. */
export interface ExecRecord {
  handle: SandboxHandle;
  req: ExecRequest;
  env: Readonly<Record<string, string>>;
  result: ExecResult;
}

/** Everything the provider knows about one sandbox. Exposed read-only for assertions. */
export interface FakeSandbox {
  readonly handle: SandboxHandle;
  readonly spec: SandboxSpec;
  /** The env file as the last `injectEnv` left it; each call replaces it. Never part of `spec`. */
  readonly injectedEnv: Readonly<Record<string, string>>;
  readonly execs: readonly ExecRecord[];
  readonly snapshots: readonly SandboxSnapshot[];
  readonly destroyed: boolean;
}

interface SandboxRecord {
  handle: SandboxHandle;
  spec: SandboxSpec;
  injectedEnv: Record<string, string>;
  execs: ExecRecord[];
  snapshots: SandboxSnapshot[];
  destroyed: boolean;
}

export interface FakeSandboxProviderOptions {
  /** Used when no handler is registered for a command. Default: exit 127, "command not found". */
  defaultHandler?: ExecHandler;
  /**
   * Exec timeout applied when the request carries none. Default: none, like DockerProvider, which
   * only arms a timer when `req.timeoutMs` is set.
   */
  defaultTimeoutMs?: number;
}

const COMMAND_NOT_FOUND: ExecHandler = (req) => ({
  exitCode: 127,
  stderr: `fake-provider: command not found: ${req.cmd[0] ?? ""}`,
});

/** Output the handler emitted through the ExecContext before it returned. */
interface PartialOutput {
  stdout: string;
  stderr: string;
}

function normalize(out: ExecHandlerResult, partial: PartialOutput): ExecResult {
  if (out === undefined) {
    return { exitCode: 0, stdout: partial.stdout, stderr: partial.stderr, timedOut: false };
  }
  if (typeof out === "string") {
    return { exitCode: 0, stdout: out, stderr: partial.stderr, timedOut: false };
  }
  return {
    exitCode: out.exitCode ?? 0,
    stdout: out.stdout ?? partial.stdout,
    stderr: out.stderr ?? partial.stderr,
    timedOut: out.timedOut ?? false,
  };
}

/** What DockerProvider returns on a timeout: the stream so far, exit -1, timedOut. */
function timedOutResult(partial: PartialOutput): ExecResult {
  return { exitCode: -1, stdout: partial.stdout, stderr: partial.stderr, timedOut: true };
}

/**
 * Fault injection. Each `fail*` arms a counter that the next N calls consume; `vanish` removes
 * a sandbox without going through `destroy`, as if the container died under the Gateway.
 */
export class FaultInjector {
  private createFailures = 0;
  private execTimeouts = 0;

  /** The next `times` calls to `create` throw `DeskmatesError("sandbox_unavailable")`. */
  failCreate(times = 1): void {
    this.createFailures += times;
  }

  /** The next `times` calls to `exec` return a timed-out result without running the handler. */
  timeoutExec(times = 1): void {
    this.execTimeouts += times;
  }

  /** Whether the next create should fail; consumes one armed failure. */
  takeCreateFailure(): boolean {
    if (this.createFailures <= 0) return false;
    this.createFailures -= 1;
    return true;
  }

  takeExecTimeout(): boolean {
    if (this.execTimeouts <= 0) return false;
    this.execTimeouts -= 1;
    return true;
  }

  reset(): void {
    this.createFailures = 0;
    this.execTimeouts = 0;
  }
}

/**
 * The host beyond the live sandboxes, for ADR-0006 amendment 5: resources a test seeds (T2
 * leftovers, former-name networks), topology problems of live sandboxes, the daemon's pools.
 */
export interface FakeHost {
  /** Listed after the live sandboxes' own resources. */
  resources: HostResource[];
  /** A live sandbox's topology verdict, by workspace id; Re-attach clears it. */
  topology: Map<string, string>;
  /** What Re-attach leaves wrong, by workspace id, instead of repairing. */
  reattachLeaves: Map<string, string>;
  addressPools?: AddressPool[];
  subnets: SandboxNetworkSubnet[];
}

export class FakeSandboxProvider implements SandboxProvider {
  readonly kind = "fake" as const;
  readonly faults = new FaultInjector();
  /** Image references `removeStaleSandbox` treats as absent from the provider. */
  readonly missingImages = new Set<string>();
  readonly host: FakeHost = {
    resources: [],
    topology: new Map(),
    reattachLeaves: new Map(),
    subnets: [],
  };

  private readonly sandboxes = new Map<string, SandboxRecord>();
  private readonly handlers = new Map<string, ExecHandler>();
  private readonly defaultHandler: ExecHandler;
  private readonly defaultTimeoutMs: number | undefined;
  private nextRef = 1;
  private nextSnapshot = 1;

  constructor(options: FakeSandboxProviderOptions = {}) {
    this.defaultHandler = options.defaultHandler ?? COMMAND_NOT_FOUND;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  // ---- scripting -------------------------------------------------------------------------

  /** Register what `exec` does when `req.cmd[0] === command`. Replaces any earlier handler. */
  onCommand(command: string, handler: ExecHandler): this {
    this.handlers.set(command, handler);
    return this;
  }

  /** Make a sandbox disappear between calls: later `exec`/`injectEnv`/`snapshot` fail, `attach` misses. */
  vanish(handle: SandboxHandle): void {
    this.sandboxes.delete(handle.providerRef);
  }

  // ---- inspection ------------------------------------------------------------------------

  /** Live sandboxes, in creation order. Vanished and destroyed ones are gone. */
  list(): readonly FakeSandbox[] {
    return [...this.sandboxes.values()].filter((s) => !s.destroyed);
  }

  /** The record for a handle, including destroyed ones; `undefined` once vanished. */
  inspect(handle: SandboxHandle): FakeSandbox | undefined {
    return this.sandboxes.get(handle.providerRef);
  }

  /** Env delivered via `injectEnv` for this handle. Empty when nothing was injected. */
  injectedEnvFor(handle: SandboxHandle): Readonly<Record<string, string>> {
    return this.sandboxes.get(handle.providerRef)?.injectedEnv ?? {};
  }

  /** The create spec for this handle. Tests assert model tokens never appear in it. */
  specFor(handle: SandboxHandle): SandboxSpec | undefined {
    return this.sandboxes.get(handle.providerRef)?.spec;
  }

  /** Every exec recorded across all sandboxes, in call order. */
  execLog(): readonly ExecRecord[] {
    const all: ExecRecord[] = [];
    for (const s of this.sandboxes.values()) all.push(...s.execs);
    return all;
  }

  // ---- SandboxProvider -------------------------------------------------------------------

  async preflight(_spec: SandboxSpec): Promise<void> {}

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    if (this.faults.takeCreateFailure()) {
      throw new DeskmatesError("sandbox_unavailable", "fake-provider: create failed (injected)", {
        workspaceId: spec.workspaceId,
      });
    }
    // Docker names the container after the workspace, so a second create is a 409, not a twin.
    for (const s of this.sandboxes.values()) {
      if (s.handle.workspaceId === spec.workspaceId && !s.destroyed) {
        throw new DeskmatesError(
          "sandbox_unavailable",
          `a sandbox already exists for workspace ${spec.workspaceId}; use attach`,
          { reason: "already_exists", workspaceId: spec.workspaceId },
        );
      }
    }
    const providerRef = `fake-${this.nextRef++}`;
    const handle: SandboxHandle = {
      workspaceId: spec.workspaceId,
      providerRef,
      sidecarAddress: `fake://${providerRef}/sidecar`,
    };
    if (spec.ports.length > 0) handle.novncAddress = `fake://${providerRef}/novnc`;
    this.sandboxes.set(providerRef, {
      handle,
      spec: { ...spec, env: { ...spec.env }, volumes: { ...spec.volumes }, ports: [...spec.ports] },
      injectedEnv: {},
      execs: [],
      snapshots: [],
      destroyed: false,
    });
    return handle;
  }

  async attach(workspaceId: WorkspaceId): Promise<SandboxHandle | undefined> {
    for (const s of this.sandboxes.values()) {
      if (s.handle.workspaceId === workspaceId && !s.destroyed) return s.handle;
    }
    return undefined;
  }

  /**
   * Like DockerProvider: a live sandbox created from another image is removed (its record stays
   * inspectable as destroyed) and reported; image references stand in for content IDs. An image
   * named in `missingImages` is `image_missing` before anything is removed.
   */
  async removeStaleSandbox(
    workspaceId: WorkspaceId,
    image: string,
    beforeRemove?: (drift: readonly SandboxImageDrift[]) => Promise<void>,
  ): Promise<readonly SandboxImageDrift[]> {
    const live = [...this.sandboxes.values()].find(
      (s) => s.handle.workspaceId === workspaceId && !s.destroyed,
    );
    if (!live) return [];
    if (this.missingImages.has(image)) {
      throw new DeskmatesError("sandbox_unavailable", `fake-provider: image not found: ${image}`, {
        reason: "image_missing",
        image,
      });
    }
    if (live.spec.image === image) return [];
    const drift = [
      { component: "workspace", runningImageId: live.spec.image, configuredImageId: image },
    ];
    await beforeRemove?.(drift);
    live.destroyed = true;
    return drift;
  }

  async exec(handle: SandboxHandle, req: ExecRequest): Promise<ExecResult> {
    if (req.cmd.length === 0) throw new DeskmatesError("validation", "exec: cmd must not be empty");
    const sandbox = this.live(handle);
    const env = { ...sandbox.spec.env, ...sandbox.injectedEnv, ...(req.env ?? {}) };
    const record = (result: ExecResult): ExecResult => {
      sandbox.execs.push({ handle, req, env, result });
      return result;
    };
    const partial: PartialOutput = { stdout: "", stderr: "" };
    if (this.faults.takeExecTimeout()) return record(timedOutResult(partial));

    const handler = this.handlers.get(req.cmd[0] ?? "") ?? this.defaultHandler;
    const ctx: ExecContext = {
      handle,
      spec: sandbox.spec,
      env,
      writeStdout: (chunk) => {
        partial.stdout += chunk;
      },
      writeStderr: (chunk) => {
        partial.stderr += chunk;
      },
    };
    const result = await withTimeout(
      Promise.resolve().then(() => handler(req, ctx)),
      req.timeoutMs ?? this.defaultTimeoutMs,
    );
    return record(result === TIMED_OUT ? timedOutResult(partial) : normalize(result, partial));
  }

  /** Runs killed by marker (ADR-0029 decision 4), in order; the fake has no processes to stop. */
  readonly killedRuns: string[] = [];
  async killRun(handle: SandboxHandle, runId: string): Promise<void> {
    this.live(handle);
    this.killedRuns.push(runId);
  }

  /** Rewrites the whole env file, like DockerProvider: a later call drops the earlier keys. */
  async injectEnv(handle: SandboxHandle, env: Readonly<Record<string, string>>): Promise<void> {
    const sandbox = this.live(handle);
    sandbox.injectedEnv = { ...env };
  }

  async updateEgress(
    handle: SandboxHandle,
    allowlist: readonly string[],
    grants: readonly NetworkGrant[] = [],
  ): Promise<undefined> {
    const sandbox = this.sandboxes.get(handle.providerRef);
    if (!sandbox) throw new DeskmatesError("not_found", "sandbox not found");
    sandbox.spec = { ...sandbox.spec, egressAllowlist: [...allowlist], egressGrants: [...grants] };
    return undefined;
  }

  async snapshot(handle: SandboxHandle): Promise<SandboxSnapshot> {
    const sandbox = this.live(handle);
    const snap: SandboxSnapshot = {
      takenAt: new Date().toISOString(),
      ref: `fake-snapshot-${this.nextSnapshot++}`,
    };
    sandbox.snapshots.push(snap);
    return snap;
  }

  /** Idempotent, like removing a container that is already gone. */
  async destroy(handle: SandboxHandle): Promise<void> {
    const sandbox = this.sandboxes.get(handle.providerRef);
    if (sandbox) sandbox.destroyed = true;
  }

  async permanentlyDelete(workspaceId: WorkspaceId): Promise<void> {
    for (const sandbox of this.sandboxes.values()) {
      if (sandbox.spec.workspaceId === workspaceId) sandbox.destroyed = true;
    }
  }

  /**
   * Each live sandbox as DockerProvider names its pieces (container, proxy, network, volumes),
   * then `host.resources`.
   */
  async listHostResources(): Promise<HostResourceInventory> {
    const resources: HostResource[] = [];
    for (const s of this.list()) {
      const id = s.spec.workspaceId;
      const problem = this.host.topology.get(id);
      resources.push(
        {
          kind: "container",
          name: `deskmates-ws-${id}`,
          id: s.handle.providerRef,
          workspaceId: id,
          role: "workspace",
          state: "running",
          sidecarProcesses: 0,
          ...(problem === undefined ? {} : { topologyProblem: problem }),
        },
        {
          kind: "container",
          name: `deskmates-egress-${id}`,
          id: `${s.handle.providerRef}-proxy`,
          workspaceId: id,
          role: "egress-proxy",
          state: "running",
        },
        {
          kind: "network",
          name: `deskmates-net-${id}`,
          id: `${s.handle.providerRef}-net`,
          workspaceId: id,
          role: "workspace",
          attachedContainers: 2,
        },
        ...Object.values(s.spec.volumes).map(
          (name): HostResource => ({
            kind: "volume",
            name,
            id: name,
            workspaceId: id,
            role: "volume",
          }),
        ),
      );
    }
    resources.push(...this.host.resources.map((r) => ({ ...r })));
    return {
      resources,
      ...(this.host.addressPools ? { addressPools: [...this.host.addressPools] } : {}),
      subnets: [...this.host.subnets],
    };
  }

  /** Like DockerProvider: containers, then networks, then volumes unless kept. */
  async removeHostResources(target: HostResourceTarget): Promise<HostResource[]> {
    const all = (await this.listHostResources()).resources;
    if (target.kind === "network") {
      const network = this.host.resources.find(
        (r) => r.kind === "network" && r.name === target.name,
      );
      if (network === undefined) return [];
      if (network.role !== "legacy")
        throw new DeskmatesError(
          "validation",
          `network ${target.name} is not a former-name network`,
        );
      if ((network.attachedContainers ?? 0) > 0)
        throw new DeskmatesError(
          "invalid_transition",
          `network ${target.name} still has containers attached`,
          { reason: "network_in_use" },
        );
      this.host.resources = this.host.resources.filter((r) => r !== network);
      return [network];
    }
    const order: HostResource["kind"][] = ["container", "network", "volume"];
    const removed = all
      .filter((r) => r.workspaceId === target.workspaceId && r.role !== "legacy")
      .filter((r) => !(target.keepVolumes && r.kind === "volume"))
      .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    this.host.resources = this.host.resources.filter(
      (r) => !removed.some((x) => x.kind === r.kind && x.id === r.id),
    );
    for (const s of this.sandboxes.values())
      if (s.spec.workspaceId === target.workspaceId) s.destroyed = true;
    this.host.topology.delete(target.workspaceId);
    return removed;
  }

  /** Clears the workspace's topology problem, unless `host.reattachLeaves` names one. */
  async reattachWorkspaceNetwork(workspaceId: WorkspaceId): Promise<{ problem?: string }> {
    const live = this.list().some((s) => s.spec.workspaceId === workspaceId);
    const seeded = this.host.resources.some(
      (r) => r.kind === "container" && r.workspaceId === workspaceId && r.role === "workspace",
    );
    if (!live && !seeded)
      throw new DeskmatesError("not_found", `workspace ${workspaceId} has no container`, {
        workspaceId,
      });
    const left = this.host.reattachLeaves.get(workspaceId);
    if (left !== undefined) return { problem: left };
    this.host.topology.delete(workspaceId);
    this.host.resources = this.host.resources.map((r) => {
      if (r.workspaceId !== workspaceId || r.kind !== "container") return r;
      const { topologyProblem: _repaired, ...rest } = r;
      return rest;
    });
    return {};
  }

  private live(handle: SandboxHandle): SandboxRecord {
    const sandbox = this.sandboxes.get(handle.providerRef);
    if (!sandbox || sandbox.destroyed) {
      throw new DeskmatesError("sandbox_unavailable", "fake-provider: sandbox is gone", {
        workspaceId: handle.workspaceId,
        providerRef: handle.providerRef,
      });
    }
    return sandbox;
  }
}

const TIMED_OUT: unique symbol = Symbol("timed-out");

function withTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T | typeof TIMED_OUT> {
  if (ms === undefined) return p;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}
